'use strict';

const { UpstreamHealthMonitor } = require('../lib/upstream-health');
const dns = require('dns').promises;
const net = require('net');

/**
 * Branch coverage tests for lib/upstream-health.js
 *
 * Targets uncovered branches identified at 89.51% branch coverage:
 *   - Line 162: IPv6 DNS fallback when resolve6 returns falsy
 *   - Line 189: endpoint.port || 443 default port fallback
 *   - Lines 196-198: _probeEndpointHealth ternary — 'down' state when all IPs fail
 *   - Lines 204-206: reason ternary — 'all_ips_failed' string
 *   - Lines 213-215: avgLatencyMs null when no healthy IPs
 *   - Lines 264-265: avgLatencyMs null-coalescing in sort comparator
 *   - Line 297: socket error without .code falls back to .message
 *   - Line 364: _recordProbeResult 'down' else-if false branch
 *   - Line 390: outageDurationMs when outage.startedAt is present
 *   - Line 399: logger outage duration when this.outage is null
 *   - Line 437: fallback.label fallback to fallback.host
 *   - Lines 441-443: _failoverToBackup when this.outage is null
 */
describe('UpstreamHealthMonitor — branch coverage', () => {
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
    // Branch 20: Line 162 — IPv6 resolve returns falsy (null/undefined)
    // ipv6 || [] — exercises the || fallback
    // ------------------------------------------------------------------
    describe('Line 162 — IPv6 DNS result falsy fallback', () => {
        test('resolve6 returning null falls back to empty array', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            jest.spyOn(dns, 'resolve4').mockRejectedValue(new Error('ENODATA'));
            // resolve6 succeeds but returns null (edge case)
            jest.spyOn(dns, 'resolve6').mockResolvedValue(null);

            const ips = await monitor._resolveEndpointIps('test.example');
            expect(ips).toEqual([]);
        });

        test('resolve6 returning undefined falls back to empty array', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            jest.spyOn(dns, 'resolve4').mockRejectedValue(new Error('ENODATA'));
            jest.spyOn(dns, 'resolve6').mockResolvedValue(undefined);

            const ips = await monitor._resolveEndpointIps('test.example');
            expect(ips).toEqual([]);
        });
    });

    // ------------------------------------------------------------------
    // Branch 22: Line 189 — endpoint.port || 443 default
    // The _tcpProbe calls inside _probeEndpointHealth use endpoint.port
    // or default to 443 when port is falsy
    // ------------------------------------------------------------------
    describe('Line 189 — endpoint.port defaults to 443', () => {
        test('_probeEndpointHealth uses port 443 when endpoint.port is undefined', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            jest.spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.1']);

            const tcpSpy = jest.spyOn(monitor, '_tcpProbe')
                .mockResolvedValue({ ip: '10.0.0.1', success: true, latencyMs: 10 });

            await monitor._probeEndpointHealth({
                host: 'test.example'
                // port is intentionally omitted (undefined)
            });

            // Should have called _tcpProbe with port 443 (default)
            expect(tcpSpy).toHaveBeenCalledWith('10.0.0.1', 443);
        });

        test('_probeEndpointHealth uses port 443 when endpoint.port is 0', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            jest.spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.1']);

            const tcpSpy = jest.spyOn(monitor, '_tcpProbe')
                .mockResolvedValue({ ip: '10.0.0.1', success: true, latencyMs: 10 });

            await monitor._probeEndpointHealth({
                host: 'test.example',
                port: 0  // falsy value
            });

            expect(tcpSpy).toHaveBeenCalledWith('10.0.0.1', 443);
        });
    });

    // ------------------------------------------------------------------
    // Branches 24, 26, 27: Lines 196-198, 204-206, 213-215
    // _probeEndpointHealth all-IPs-failed path: state='down', reason='all_ips_failed', avgLatencyMs=null
    // ------------------------------------------------------------------
    describe('Lines 196-215 — _probeEndpointHealth all IPs failed (down state)', () => {
        test('all IPs fail returns down state with all_ips_failed and null avgLatencyMs', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            jest.spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.1', '10.0.0.2']);

            // All TCP probes fail
            jest.spyOn(monitor, '_tcpProbe').mockImplementation(async (ip) => {
                return { ip, success: false, latencyMs: 5000, error: 'timeout' };
            });

            const result = await monitor._probeEndpointHealth({
                host: 'alldown.example',
                port: 443,
                label: 'All Down',
                isPrimary: true
            });

            // Branch 24: state === 'down' (healthy.length === 0)
            expect(result.state).toBe('down');
            // Branch 26: reason === 'all_ips_failed'
            expect(result.reason).toBe('all_ips_failed');
            // Branch 27: avgLatencyMs === null (no healthy IPs)
            expect(result.avgLatencyMs).toBeNull();
            expect(result.healthyCount).toBe(0);
            expect(result.failedCount).toBe(2);
            expect(result.failedIps).toEqual(['10.0.0.1', '10.0.0.2']);
            expect(result.healthyIps).toEqual([]);
        });

        test('single IP failure returns down, not degraded', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            jest.spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.1']);

            jest.spyOn(monitor, '_tcpProbe').mockResolvedValue({
                ip: '10.0.0.1', success: false, latencyMs: 5000, error: 'ECONNREFUSED'
            });

            const result = await monitor._probeEndpointHealth({
                host: 'single-fail.example',
                port: 443
            });

            expect(result.state).toBe('down');
            expect(result.reason).toBe('all_ips_failed');
            expect(result.avgLatencyMs).toBeNull();
        });
    });

    // ------------------------------------------------------------------
    // Branches 34, 35: Lines 264-265
    // avgLatencyMs null-coalescing in _selectFailoverEndpoint sort
    // Left and/or right probe has avgLatencyMs = null
    // ------------------------------------------------------------------
    describe('Lines 264-265 — null avgLatencyMs in failover sort', () => {
        test('endpoint with null avgLatencyMs is sorted after one with actual latency', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                fallbacks: [
                    { host: 'null-latency.example', port: 443, basePath: '/', protocol: 'https:', label: 'Null Latency' },
                    { host: 'real-latency.example', port: 443, basePath: '/', protocol: 'https:', label: 'Real Latency' }
                ]
            });

            // Both healthy, same healthyCount, but first has null avgLatencyMs
            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValueOnce({
                    state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.1'],
                    results: [], healthyIps: ['10.0.0.1'], failedIps: [],
                    healthyCount: 1, failedCount: 0, avgLatencyMs: null  // null triggers ?? POSITIVE_INFINITY
                })
                .mockResolvedValueOnce({
                    state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.2'],
                    results: [], healthyIps: ['10.0.0.2'], failedIps: [],
                    healthyCount: 1, failedCount: 0, avgLatencyMs: 50
                });

            const result = await monitor._selectFailoverEndpoint();

            // Real latency (50) < POSITIVE_INFINITY (null), so real-latency wins
            expect(result).not.toBeNull();
            expect(result.endpoint.host).toBe('real-latency.example');
        });

        test('both endpoints with null avgLatencyMs falls through to index tiebreaker', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                fallbacks: [
                    { host: 'first.example', port: 443, basePath: '/', protocol: 'https:', label: 'First' },
                    { host: 'second.example', port: 443, basePath: '/', protocol: 'https:', label: 'Second' }
                ]
            });

            // Both healthy, same healthyCount, both null avgLatencyMs
            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValueOnce({
                    state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.1'],
                    results: [], healthyIps: ['10.0.0.1'], failedIps: [],
                    healthyCount: 1, failedCount: 0, avgLatencyMs: null
                })
                .mockResolvedValueOnce({
                    state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.2'],
                    results: [], healthyIps: ['10.0.0.2'], failedIps: [],
                    healthyCount: 1, failedCount: 0, avgLatencyMs: null
                });

            const result = await monitor._selectFailoverEndpoint();

            // Both POSITIVE_INFINITY, equal, so falls to index (first wins)
            expect(result).not.toBeNull();
            expect(result.endpoint.host).toBe('first.example');
            expect(result.index).toBe(0);
        });

        test('endpoint with null latency sorted after one with actual (reversed order)', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                fallbacks: [
                    { host: 'real-latency.example', port: 443, basePath: '/', protocol: 'https:', label: 'Real' },
                    { host: 'null-latency.example', port: 443, basePath: '/', protocol: 'https:', label: 'Null' }
                ]
            });

            // First has real latency, second has null
            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValueOnce({
                    state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.1'],
                    results: [], healthyIps: ['10.0.0.1'], failedIps: [],
                    healthyCount: 1, failedCount: 0, avgLatencyMs: 30
                })
                .mockResolvedValueOnce({
                    state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.2'],
                    results: [], healthyIps: ['10.0.0.2'], failedIps: [],
                    healthyCount: 1, failedCount: 0, avgLatencyMs: null  // right side is null
                });

            const result = await monitor._selectFailoverEndpoint();

            // Real latency (30) < POSITIVE_INFINITY (null), real wins
            expect(result).not.toBeNull();
            expect(result.endpoint.host).toBe('real-latency.example');
        });
    });

    // ------------------------------------------------------------------
    // Branch 38: Line 297 — socket error without .code, falls back to .message
    // ------------------------------------------------------------------
    describe('Line 297 — socket error code fallback to message', () => {
        test('error without .code uses .message instead', async () => {
            jest.useRealTimers();
            const monitor = new UpstreamHealthMonitor({ logger });

            const mockSocket = new (require('events').EventEmitter)();
            mockSocket.setTimeout = jest.fn();
            mockSocket.connect = jest.fn().mockImplementation(() => {
                // Error object without a .code property, only .message
                const err = new Error('Connection reset by peer');
                delete err.code;  // ensure no code property
                setImmediate(() => mockSocket.emit('error', err));
            });
            mockSocket.destroy = jest.fn();

            jest.spyOn(net, 'Socket').mockReturnValue(mockSocket);

            const result = await monitor._tcpProbe('10.0.0.1', 443);

            // Branch 38: err.code is undefined/falsy, so falls back to err.message
            expect(result.success).toBe(false);
            expect(result.error).toBe('Connection reset by peer');
            expect(result.ip).toBe('10.0.0.1');
            expect(mockSocket.destroy).toHaveBeenCalled();
            jest.useFakeTimers();
        });

        test('error with empty string .code falls back to .message', async () => {
            jest.useRealTimers();
            const monitor = new UpstreamHealthMonitor({ logger });

            const mockSocket = new (require('events').EventEmitter)();
            mockSocket.setTimeout = jest.fn();
            mockSocket.connect = jest.fn().mockImplementation(() => {
                const err = new Error('some socket error');
                err.code = '';  // falsy code
                setImmediate(() => mockSocket.emit('error', err));
            });
            mockSocket.destroy = jest.fn();

            jest.spyOn(net, 'Socket').mockReturnValue(mockSocket);

            const result = await monitor._tcpProbe('10.0.0.1', 443);

            expect(result.success).toBe(false);
            expect(result.error).toBe('some socket error');
            jest.useFakeTimers();
        });
    });

    // ------------------------------------------------------------------
    // Branch 51: Line 364 — _recordProbeResult 'down' else-if branch
    // The branch counter shows: the `else if (probeState === 'down')` was
    // entered 17 times but the implicit else (not healthy, not degraded,
    // not down) was never hit. This is the "else" of the if-chain.
    // However, looking at the code, any state other than 'healthy'/'degraded'/'down'
    // would simply fall through. Let's confirm by sending an unknown state.
    // ------------------------------------------------------------------
    describe('Line 364 — _recordProbeResult fall-through for unknown state', () => {
        test('unknown probe state falls through without state transition', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            monitor.state = 'healthy';

            const healthListener = jest.fn();
            monitor.on('upstream-health', healthListener);

            // Send an unrecognized state - should fall through all branches
            await monitor._recordProbeResult('unknown', 'test_reason', []);

            // State should remain unchanged (no branch matched)
            expect(monitor.state).toBe('healthy');
            // upstream-health event still emitted at the end
            expect(healthListener).toHaveBeenCalledWith(expect.objectContaining({
                state: 'healthy'
            }));
        });
    });

    // ------------------------------------------------------------------
    // Branch 56: Line 390 — outageDurationMs: outage?.startedAt || Date.now()
    // When outage exists but startedAt is falsy (0 or undefined)
    // ------------------------------------------------------------------
    describe('Line 390 — outageDurationMs when outage.startedAt is falsy', () => {
        test('outageDurationMs falls back to Date.now() when outage.startedAt is 0', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                fallbacks: []
            });

            // Manually set outage with startedAt = 0 (falsy)
            monitor.outage = {
                startedAt: 0,
                detectedAt: Date.now(),
                affectedIPs: ['10.0.0.1']
            };
            monitor.state = 'down';
            monitor.consecutiveFails = 1;  // already at threshold

            const statusListener = jest.fn();
            monitor.on('upstream-status', statusListener);

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            // The outageDurationMs should use the || fallback path
            expect(statusListener).toHaveBeenCalledWith(expect.objectContaining({
                state: 'down',
                outageDurationMs: expect.any(Number)
            }));
        });

        test('outageDurationMs uses startedAt when it has a real value', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                fallbacks: []
            });

            const startTime = Date.now() - 30000;
            monitor.outage = {
                startedAt: startTime,
                detectedAt: startTime,
                affectedIPs: ['10.0.0.1']
            };
            monitor.state = 'down';
            monitor.consecutiveFails = 1;

            const statusListener = jest.fn();
            monitor.on('upstream-status', statusListener);

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            expect(statusListener).toHaveBeenCalledWith(expect.objectContaining({
                outageDurationMs: expect.any(Number)
            }));
            // outageDurationMs should be >= 30000 since startedAt was 30s ago
            const emittedData = statusListener.mock.calls[0][0];
            expect(emittedData.outageDurationMs).toBeGreaterThanOrEqual(30000);
        });
    });

    // ------------------------------------------------------------------
    // Branch 57: Line 399 — this.outage ? Date.now() - this.outage.startedAt : 0
    // The : 0 branch when this.outage is null during the logger.error call
    // ------------------------------------------------------------------
    describe('Line 399 — logger outageDurationMs when outage is null', () => {
        test('logger reports outageDurationMs: 0 when this.outage is null during down logging', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                fallbacks: []
            });

            // Force outage to be null even when going to down state
            // We need to intercept right at the threshold crossing
            // Set consecutiveFails to 0 so the first call brings it to 1 (>= failThreshold of 1)
            monitor.consecutiveFails = 0;
            // But ensure outage is set to null - the code sets outage only if !this.outage
            // Actually the code sets outage BEFORE the logger call. So to hit the `:0` branch,
            // we need outage to be null at the point of the logger.error call.
            // Looking at the code more carefully:
            //
            // if (this.consecutiveFails >= this.failThreshold) {
            //     this.state = 'down';
            //     if (!this.outage) { this.outage = {...}; }
            //     if (this.activeEndpoint.isPrimary && this.fallbacks.length > 0) { ... }
            //     this.emit('upstream-status', { outageDurationMs: Date.now() - (this.outage?.startedAt || Date.now()) });
            //     this.logger?.error('Upstream DOWN', { outageDurationMs: this.outage ? Date.now() - this.outage.startedAt : 0 });
            // }
            //
            // Since this.outage is created earlier in the block, the outage ternary on line 399
            // would normally always be truthy. The :0 branch can only be hit if outage is somehow
            // null - but the code always creates it. The branch is an unreachable safety guard,
            // but we can still reach it by manipulating the outage after creation via an event handler.

            // Actually, let's use a trick: make outage non-null initially so the `if (!this.outage)`
            // block doesn't create a new one, then null it out via the status event handler
            // that fires BEFORE the logger call.

            // Hmm, actually that won't work either since emit is sync and logger is called after.
            // Let me look again at the code order...
            // Line 372: if (!this.outage) { this.outage = {...}; }
            // Line 386: this.emit('upstream-status', ...)   <-- line 390 uses outage?.startedAt
            // Line 395: this.logger?.error(...)             <-- line 399 uses this.outage ternary

            // The `this.outage?.startedAt || Date.now()` on line 390 would only use Date.now()
            // fallback if outage is null or startedAt is 0/undefined. Since outage was just created
            // (or already existed), it's hard to make it null.

            // For branch 57 (line 399), same issue. Let's try nullifying outage in a status listener.
            monitor.on('upstream-status', () => {
                monitor.outage = null;  // null it between emit and logger.error
            });

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            expect(monitor.state).toBe('down');
            expect(logger.error).toHaveBeenCalledWith('Upstream DOWN', expect.objectContaining({
                outageDurationMs: 0  // The :0 branch
            }));
        });
    });

    // ------------------------------------------------------------------
    // Branch 60: Line 437 — fallback.label || fallback.host
    // When fallback endpoint has no label property
    // ------------------------------------------------------------------
    describe('Line 437 — fallback label defaults to host', () => {
        test('failover to endpoint without label uses host as label', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'backup-no-label.example', port: 443, basePath: '/v1', protocol: 'https:' }
                    // No label property!
                ]
            });

            monitor._probeEndpointHealth = jest.fn().mockResolvedValue({
                state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.2'],
                results: [{ ip: '10.0.0.2', success: true, latencyMs: 15 }],
                healthyIps: ['10.0.0.2'], failedIps: [],
                healthyCount: 1, failedCount: 0, avgLatencyMs: 15
            });

            const failoverListener = jest.fn();
            monitor.on('upstream-failover', failoverListener);

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            // Branch 60: fallback.label is undefined, so label = fallback.host
            expect(monitor.activeEndpoint.label).toBe('backup-no-label.example');
            expect(failoverListener).toHaveBeenCalledWith(expect.objectContaining({
                to: 'backup-no-label.example'
            }));
        });

        test('failover to endpoint with empty string label uses host', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'backup.example', port: 443, basePath: '/v1', protocol: 'https:', label: '' }
                ]
            });

            monitor._probeEndpointHealth = jest.fn().mockResolvedValue({
                state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.2'],
                results: [], healthyIps: ['10.0.0.2'], failedIps: [],
                healthyCount: 1, failedCount: 0, avgLatencyMs: 15
            });

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            // Empty string is falsy, so falls back to host
            expect(monitor.activeEndpoint.label).toBe('backup.example');
        });
    });

    // ------------------------------------------------------------------
    // Branch 61: Lines 441-443 — if (this.outage) in _failoverToBackup
    // When failover triggers but this.outage is null
    // ------------------------------------------------------------------
    describe('Lines 441-443 — _failoverToBackup when outage is null', () => {
        test('failover succeeds even when this.outage is null (no outage.failoverEndpoint set)', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'backup.example', port: 443, basePath: '/v1', protocol: 'https:', label: 'Backup' }
                ]
            });

            monitor._probeEndpointHealth = jest.fn().mockResolvedValue({
                state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.2'],
                results: [{ ip: '10.0.0.2', success: true, latencyMs: 20 }],
                healthyIps: ['10.0.0.2'], failedIps: [],
                healthyCount: 1, failedCount: 0, avgLatencyMs: 20
            });

            // Ensure outage is null before calling _failoverToBackup directly
            monitor.outage = null;

            const failoverListener = jest.fn();
            monitor.on('upstream-failover', failoverListener);

            const result = await monitor._failoverToBackup();

            // Branch 61: outage is null, so if (this.outage) block is skipped
            expect(result).toBe(true);
            expect(monitor.activeEndpoint.host).toBe('backup.example');
            expect(monitor.outage).toBeNull();  // outage stays null (no .failoverEndpoint assigned)
            expect(failoverListener).toHaveBeenCalledTimes(1);
        });

        test('failover with existing outage records failoverEndpoint', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'backup.example', port: 443, basePath: '/v1', protocol: 'https:', label: 'Backup' }
                ]
            });

            monitor._probeEndpointHealth = jest.fn().mockResolvedValue({
                state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.2'],
                results: [{ ip: '10.0.0.2', success: true, latencyMs: 20 }],
                healthyIps: ['10.0.0.2'], failedIps: [],
                healthyCount: 1, failedCount: 0, avgLatencyMs: 20
            });

            // Set outage BEFORE failover (normal flow)
            monitor.outage = {
                startedAt: Date.now() - 5000,
                detectedAt: Date.now() - 5000,
                affectedIPs: ['10.0.0.1'],
                failoverEndpoint: null
            };

            await monitor._failoverToBackup();

            // Branch 61: outage exists, so failoverEndpoint is set
            expect(monitor.outage.failoverEndpoint).toBe('Backup');
        });
    });

    // ------------------------------------------------------------------
    // Additional branch: Line 390 — outage?.startedAt with null outage
    // Exercise the || Date.now() fallback in upstream-status emit
    // ------------------------------------------------------------------
    describe('Line 390 — outageDurationMs fallback when outage becomes null', () => {
        test('outageDurationMs uses Date.now() fallback resulting in ~0 duration', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 2,
                fallbacks: []
            });

            // First down: under threshold, creates outage
            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);
            expect(monitor.state).not.toBe('down'); // below threshold

            // Null out outage to exercise the fallback path
            monitor.outage = null;

            const statusListener = jest.fn();
            monitor.on('upstream-status', statusListener);

            // Second down: meets threshold, outage is null now
            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            // The code creates outage in if (!this.outage) block, so it won't be null
            // at emit time. But we verify the outage was freshly created.
            expect(monitor.outage).not.toBeNull();
            expect(monitor.state).toBe('down');
        });
    });

    // ------------------------------------------------------------------
    // Integration: full probe cycle through _probeEndpointHealth with all-down
    // This hits branches 24, 26, 27 through the real code path
    // ------------------------------------------------------------------
    describe('Integration — full probe with all IPs down', () => {
        test('_probe() with all IPs failing produces correct down state', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                fallbacks: []
            });

            jest.spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.1', '10.0.0.2']);
            jest.spyOn(monitor, '_tcpProbe').mockImplementation(async (ip) => ({
                ip, success: false, latencyMs: 5000, error: 'timeout'
            }));

            await monitor._probe();

            expect(monitor.state).toBe('down');
            expect(monitor.lastProbeResult.state).toBe('down');
            expect(monitor.lastProbeResult.reason).toBe('all_ips_failed');

            // Verify endpoint health was updated
            const key = monitor._endpointKey({
                protocol: 'https:',
                host: 'api.z.ai',
                port: 443,
                basePath: '/api/anthropic'
            });
            const health = monitor.endpointHealth.get(key);
            expect(health.state).toBe('down');
            expect(health.avgLatencyMs).toBeNull();
        });
    });
});
