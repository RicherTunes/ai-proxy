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
        this.endpointHealth = new Map(); // endpoint key -> { state, lastCheck, ... }

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
            endpointHealth: Object.fromEntries(this.endpointHealth),
            history: this.history.slice(-5)
        };
    }

    /**
     * Probe the primary endpoint health
     */
    async _probe() {
        this.lastProbeAt = Date.now();

        try {
            const probe = await this._probeEndpointHealth({
                host: this.primaryHost,
                port: this.primaryPort,
                basePath: this.primaryBasePath,
                protocol: this.primaryProtocol,
                label: 'Primary (z.ai)',
                isPrimary: true
            });

            probe.results.forEach(r => {
                this.ipHealth.set(r.ip, {
                    healthy: r.success,
                    lastCheck: Date.now(),
                    latencyMs: r.latencyMs,
                    error: r.error || null
                });
            });

            if (probe.state === 'healthy') {
                await this._recordProbeResult('healthy', probe.reason, probe.ips);
            } else if (probe.state === 'degraded') {
                await this._recordProbeResult('degraded', probe.reason, probe.failedIps);
            } else {
                await this._recordProbeResult('down', probe.reason, probe.ips);
            }
        } catch (err) {
            this.logger?.error('Upstream probe error', { error: err.message });
            await this._recordProbeResult('down', 'probe_error', []);
        }
    }

    _endpointKey(endpoint) {
        return `${endpoint.protocol || 'https:'}//${endpoint.host}:${endpoint.port || 443}${endpoint.basePath || ''}`;
    }

    async _resolveEndpointIps(host) {
        try {
            return await dns.resolve4(host);
        } catch (e) {
            try {
                const ipv6 = await dns.resolve6(host);
                return ipv6 || [];
            } catch (_e2) {
                return [];
            }
        }
    }

    async _probeEndpointHealth(endpoint) {
        const ips = await this._resolveEndpointIps(endpoint.host);
        if (ips.length === 0) {
            const downResult = {
                endpoint,
                state: 'down',
                reason: 'dns_failed',
                ips: [],
                results: [],
                healthyIps: [],
                failedIps: [],
                healthyCount: 0,
                failedCount: 0,
                avgLatencyMs: null
            };
            this._updateEndpointHealth(endpoint, downResult);
            return downResult;
        }

        const results = await Promise.all(
            ips.map(ip => this._tcpProbe(ip, endpoint.port || 443))
        );

        const healthy = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        const state = healthy.length === ips.length
            ? 'healthy'
            : healthy.length > 0
                ? 'degraded'
                : 'down';
        const summary = {
            endpoint,
            state,
            reason: healthy.length === ips.length
                ? 'all_ips_ok'
                : healthy.length > 0
                    ? 'partial_failure'
                    : 'all_ips_failed',
            ips,
            results,
            healthyIps: healthy.map(r => r.ip),
            failedIps: failed.map(r => r.ip),
            healthyCount: healthy.length,
            failedCount: failed.length,
            avgLatencyMs: healthy.length > 0
                ? Math.round(healthy.reduce((total, result) => total + result.latencyMs, 0) / healthy.length)
                : null
        };

        this._updateEndpointHealth(endpoint, summary);
        return summary;
    }

    _updateEndpointHealth(endpoint, summary) {
        this.endpointHealth.set(this._endpointKey(endpoint), {
            host: endpoint.host,
            label: endpoint.label || endpoint.host,
            isPrimary: !!endpoint.isPrimary,
            state: summary.state,
            reason: summary.reason,
            lastCheck: Date.now(),
            healthyCount: summary.healthyCount,
            failedCount: summary.failedCount,
            avgLatencyMs: summary.avgLatencyMs
        });
    }

    async _selectFailoverEndpoint() {
        if (!Array.isArray(this.fallbacks) || this.fallbacks.length === 0) return null;

        const results = await Promise.all(
            this.fallbacks.map(async (fallback, index) => ({
                endpoint: fallback,
                index,
                probe: await this._probeEndpointHealth(fallback)
            }))
        );

        const rankForState = (state) => {
            switch (state) {
                case 'healthy': return 2;
                case 'degraded': return 1;
                default: return 0;
            }
        };

        const candidates = results
            .filter(result => rankForState(result.probe.state) > 0)
            .sort((left, right) => {
                const stateDelta = rankForState(right.probe.state) - rankForState(left.probe.state);
                if (stateDelta !== 0) return stateDelta;

                const successDelta = right.probe.healthyCount - left.probe.healthyCount;
                if (successDelta !== 0) return successDelta;

                const leftLatency = left.probe.avgLatencyMs ?? Number.POSITIVE_INFINITY;
                const rightLatency = right.probe.avgLatencyMs ?? Number.POSITIVE_INFINITY;
                if (leftLatency !== rightLatency) return leftLatency - rightLatency;

                return left.index - right.index;
            });

        return candidates[0] || null;
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
    async _recordProbeResult(probeState, reason, affectedIPs) {
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
                    await this._failoverToBackup();
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
    async _failoverToBackup() {
        const candidate = await this._selectFailoverEndpoint();
        if (!candidate) {
            this.logger?.warn('Upstream failover skipped: no healthy fallback endpoints available', {
                attemptedFallbacks: this.fallbacks.map(fallback => fallback.host)
            });
            return false;
        }

        const fallback = candidate.endpoint;

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

        return true;
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
