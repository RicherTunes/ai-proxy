/**
 * Upstream Health Monitor
 *
 * Monitors upstream API endpoint health via TCP connect probes.
 * Detects outages, tracks duration, and triggers automatic failover
 * to backup endpoints.
 */
'use strict';

const { EventEmitter } = require('events');
const net = require('net');
const dns = require('dns').promises;
const https = require('https');

class UpstreamHealthMonitor extends EventEmitter {
    constructor(options = {}) {
        super();
        this.logger = options.logger || null;

        // Primary endpoint
        this.primaryHost = options.primaryHost || 'api.z.ai';
        this.primaryPort = options.primaryPort || 443;
        this.primaryBasePath = options.primaryBasePath || '/api/anthropic';
        this.primaryProtocol = options.primaryProtocol || 'https:';

        // Fallback endpoints (tried in order)
        this.fallbacks = options.fallbacks || [
            {
                host: 'open.bigmodel.cn',
                port: 443,
                basePath: '/api/paas/v4',
                protocol: 'https:',
                label: 'BigModel CN'
            }
        ];

        // Probe settings
        this.probeIntervalMs = options.probeIntervalMs || 15000;
        this.probeTimeoutMs = options.probeTimeoutMs || 5000;
        this.failThreshold = options.failThreshold || 2;  // consecutive fails before marking down

        // State
        this.state = 'healthy';  // healthy | degraded | down
        this.activeEndpoint = {
            host: this.primaryHost,
            port: this.primaryPort,
            basePath: this.primaryBasePath,
            protocol: this.primaryProtocol,
            label: 'Primary (z.ai)',
            isPrimary: true
        };
        this.outage = null;      // { startedAt, detectedAt, duration, affectedIPs, recoveredAt }
        this.history = [];       // last 10 outages
        this.consecutiveFails = 0;
        this.consecutiveSuccesses = 0;
        this.lastProbeAt = null;
        this.lastProbeResult = null;
        this.ipHealth = new Map();  // ip -> { healthy, lastCheck, latencyMs }

        this._probeTimer = null;
        this._recovering = false;  // flag to prevent flip-flopping
    }

    start() {
        if (this._probeTimer) return;
        this.logger?.info('Upstream health monitor started', {
            primary: this.primaryHost,
            fallbacks: this.fallbacks.map(f => f.host),
            probeInterval: this.probeIntervalMs
        });

        // Initial probe
        this._probe();

        // Periodic probes
        this._probeTimer = setInterval(() => this._probe(), this.probeIntervalMs);
        this._probeTimer.unref();
    }

    stop() {
        if (this._probeTimer) {
            clearInterval(this._probeTimer);
            this._probeTimer = null;
        }
    }

    /**
     * Get current health status (for API/dashboard)
     */
    getStatus() {
        return {
            state: this.state,
            activeEndpoint: {
                host: this.activeEndpoint.host,
                label: this.activeEndpoint.label,
                isPrimary: this.activeEndpoint.isPrimary
            },
            outage: this.outage ? {
                startedAt: this.outage.startedAt,
                durationMs: Date.now() - this.outage.startedAt,
                affectedIPs: this.outage.affectedIPs
            } : null,
            lastProbe: this.lastProbeAt,
            lastProbeResult: this.lastProbeResult,
            ipHealth: Object.fromEntries(this.ipHealth),
            history: this.history.slice(-5)
        };
    }

    /**
     * Probe the primary endpoint health
     */
    async _probe() {
        this.lastProbeAt = Date.now();

        try {
            // Resolve DNS
            let ips = [];
            try {
                ips = await dns.resolve4(this.primaryHost);
            } catch (e) {
                // DNS failed — try IPv6
                try {
                    const ipv6 = await dns.resolve6(this.primaryHost);
                    ips = ipv6 || [];
                } catch (_e2) {
                    ips = [];
                }
            }

            if (ips.length === 0) {
                this._recordProbeResult('down', 'dns_failed', []);
                return;
            }

            // TCP connect test to each IP
            const results = await Promise.all(
                ips.map(ip => this._tcpProbe(ip, this.primaryPort))
            );

            const healthy = results.filter(r => r.success);
            const failed = results.filter(r => !r.success);

            // Update per-IP health
            results.forEach(r => {
                this.ipHealth.set(r.ip, {
                    healthy: r.success,
                    lastCheck: Date.now(),
                    latencyMs: r.latencyMs,
                    error: r.error || null
                });
            });

            if (healthy.length === ips.length) {
                this._recordProbeResult('healthy', 'all_ips_ok', ips);
            } else if (healthy.length > 0) {
                this._recordProbeResult('degraded', 'partial_failure', failed.map(r => r.ip));
            } else {
                this._recordProbeResult('down', 'all_ips_failed', ips);
            }
        } catch (err) {
            this.logger?.error('Upstream probe error', { error: err.message });
            this._recordProbeResult('down', 'probe_error', []);
        }
    }

    /**
     * TCP connect probe to a specific IP
     */
    _tcpProbe(ip, port) {
        return new Promise(resolve => {
            const start = Date.now();
            const socket = new net.Socket();

            socket.setTimeout(this.probeTimeoutMs);

            socket.on('connect', () => {
                const latencyMs = Date.now() - start;
                socket.destroy();
                resolve({ ip, success: true, latencyMs });
            });

            socket.on('timeout', () => {
                socket.destroy();
                resolve({ ip, success: false, latencyMs: Date.now() - start, error: 'timeout' });
            });

            socket.on('error', (err) => {
                socket.destroy();
                resolve({ ip, success: false, latencyMs: Date.now() - start, error: err.code || err.message });
            });

            socket.connect(port, ip);
        });
    }

    /**
     * Process probe result and trigger state transitions
     */
    _recordProbeResult(probeState, reason, affectedIPs) {
        this.lastProbeResult = { state: probeState, reason, timestamp: Date.now() };

        const prevState = this.state;

        if (probeState === 'healthy') {
            this.consecutiveFails = 0;
            this.consecutiveSuccesses++;

            if (prevState !== 'healthy') {
                // Require more successes after failover to prevent flip-flop
                var recoveryThreshold = this.activeEndpoint.isPrimary ? 2 : 5;
                if (this.consecutiveSuccesses >= recoveryThreshold || prevState === 'degraded') {
                    // Don't switch back to primary if we failed over less than 60s ago
                    var failoverAge = this._lastFailoverAt ? Date.now() - this._lastFailoverAt : Infinity;
                    if (!this.activeEndpoint.isPrimary && failoverAge < 60000) {
                        // Too soon to switch back, keep counting successes
                        return;
                    }
                    this.state = 'healthy';
                    if (!this.activeEndpoint.isPrimary) {
                        this._switchToPrimary();
                    }

                    // Close outage
                    if (this.outage) {
                        this.outage.recoveredAt = Date.now();
                        this.outage.durationMs = this.outage.recoveredAt - this.outage.startedAt;
                        this.history.push({ ...this.outage });
                        if (this.history.length > 10) this.history.shift();

                        this.logger?.info('Upstream recovered', {
                            durationMs: this.outage.durationMs,
                            endpoint: this.activeEndpoint.host
                        });

                        this.emit('upstream-recovered', {
                            durationMs: this.outage.durationMs,
                            previousEndpoint: this.activeEndpoint.label,
                            timestamp: Date.now()
                        });

                        this.outage = null;
                    }
                }
            }
        } else if (probeState === 'degraded') {
            this.consecutiveSuccesses = 0;
            this.state = 'degraded';

            this.emit('upstream-status', {
                state: 'degraded',
                reason,
                affectedIPs,
                activeEndpoint: this.activeEndpoint.label,
                timestamp: Date.now()
            });
        } else if (probeState === 'down') {
            this.consecutiveSuccesses = 0;
            this.consecutiveFails++;

            if (this.consecutiveFails >= this.failThreshold) {
                this.state = 'down';

                // Start outage tracking
                if (!this.outage) {
                    this.outage = {
                        startedAt: Date.now(),
                        detectedAt: Date.now(),
                        affectedIPs: affectedIPs,
                        failoverEndpoint: null
                    };
                }

                // Trigger failover if on primary
                if (this.activeEndpoint.isPrimary && this.fallbacks.length > 0) {
                    this._failoverToBackup();
                }

                this.emit('upstream-status', {
                    state: 'down',
                    reason,
                    affectedIPs,
                    outageDurationMs: Date.now() - (this.outage?.startedAt || Date.now()),
                    activeEndpoint: this.activeEndpoint.label,
                    timestamp: Date.now()
                });

                this.logger?.error('Upstream DOWN', {
                    reason,
                    consecutiveFails: this.consecutiveFails,
                    affectedIPs,
                    outageDurationMs: this.outage ? Date.now() - this.outage.startedAt : 0
                });
            }
        }

        // Always emit status for dashboard
        this.emit('upstream-health', {
            state: this.state,
            activeEndpoint: this.activeEndpoint.label,
            isPrimary: this.activeEndpoint.isPrimary,
            outage: this.outage ? {
                startedAt: this.outage.startedAt,
                durationMs: Date.now() - this.outage.startedAt
            } : null,
            timestamp: Date.now()
        });
    }

    /**
     * Switch to a backup endpoint
     */
    _failoverToBackup() {
        const fallback = this.fallbacks[0];  // Try first fallback
        if (!fallback) return;

        const prevEndpoint = this.activeEndpoint.label;
        this.activeEndpoint = {
            host: fallback.host,
            port: fallback.port,
            basePath: fallback.basePath,
            protocol: fallback.protocol,
            label: fallback.label || fallback.host,
            isPrimary: false
        };

        if (this.outage) {
            this.outage.failoverEndpoint = this.activeEndpoint.label;
        }

        this._lastFailoverAt = Date.now();
        this.logger?.warn('Upstream failover activated', {
            from: prevEndpoint,
            to: this.activeEndpoint.label,
            host: this.activeEndpoint.host
        });

        this.emit('upstream-failover', {
            from: prevEndpoint,
            to: this.activeEndpoint.label,
            host: this.activeEndpoint.host,
            basePath: this.activeEndpoint.basePath,
            timestamp: Date.now()
        });
    }

    /**
     * Switch back to primary endpoint
     */
    _switchToPrimary() {
        const prevEndpoint = this.activeEndpoint.label;
        this.activeEndpoint = {
            host: this.primaryHost,
            port: this.primaryPort,
            basePath: this.primaryBasePath,
            protocol: this.primaryProtocol,
            label: 'Primary (z.ai)',
            isPrimary: true
        };

        this.logger?.info('Upstream restored to primary', {
            from: prevEndpoint,
            to: this.activeEndpoint.label
        });

        this.emit('upstream-restored', {
            from: prevEndpoint,
            to: this.activeEndpoint.label,
            timestamp: Date.now()
        });
    }

    /**
     * Get the currently active target configuration (used by request handler)
     */
    getActiveTarget() {
        return {
            host: this.activeEndpoint.host,
            basePath: this.activeEndpoint.basePath,
            protocol: this.activeEndpoint.protocol
        };
    }
}

module.exports = { UpstreamHealthMonitor };
