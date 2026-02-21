#!/usr/bin/env node
/**
 * GLM Proxy Monitor
 * Polls /stats every 30s and logs health metrics
 * Detects anomalies and tracks trends
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PROXY_URL = 'http://127.0.0.1:18765';
const POLL_INTERVAL = 30000;  // 30 seconds
const LOG_FILE = path.join(__dirname, 'monitor.log');

// Historical tracking
let history = {
    samples: [],
    maxSamples: 120,  // Keep 1 hour of data (120 * 30s)
    alerts: [],
    startTime: Date.now()
};

// Thresholds for alerts
const THRESHOLDS = {
    errorRatePercent: 10,       // Alert if >10% error rate
    avgLatencyMs: 15000,        // Alert if avg latency >15s
    circuitOpenCount: 2,        // Alert if 2+ circuits open
    retryRatePercent: 20,       // Alert if >20% retry rate
    socketHangupSpike: 10       // Alert if >10 hangups in window
};

function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
}

function fetchStats() {
    return new Promise((resolve, reject) => {
        const req = http.get(`${PROXY_URL}/stats`, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Invalid JSON response'));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

function analyzeStats(stats, prevStats) {
    const issues = [];
    const metrics = {};

    // Calculate aggregate metrics
    const totalRequests = stats.keys.reduce((sum, k) => sum + k.total, 0);
    const totalSuccesses = stats.keys.reduce((sum, k) => sum + k.successes, 0);
    const totalFailures = stats.keys.reduce((sum, k) => sum + k.failures, 0);
    const totalErrors = stats.errors.timeouts + stats.errors.socketHangups +
                        stats.errors.connectionRefused + stats.errors.other;

    // Latency analysis
    const latencies = stats.keys.filter(k => k.avgLatency).map(k => k.avgLatency);
    const avgLatency = latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;
    const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
    const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;

    // Circuit breaker status
    const openCircuits = stats.keys.filter(k => k.state === 'OPEN').length;
    const halfOpenCircuits = stats.keys.filter(k => k.state === 'HALF_OPEN').length;

    // Error rate
    const errorRate = totalRequests > 0 ? (totalErrors / totalRequests * 100) : 0;
    const retryRate = totalRequests > 0 ? (stats.errors.totalRetries / totalRequests * 100) : 0;

    // Load distribution analysis
    const requestCounts = stats.keys.map(k => k.total);
    const avgRequests = requestCounts.reduce((a, b) => a + b, 0) / requestCounts.length;
    const maxDeviation = Math.max(...requestCounts.map(c => Math.abs(c - avgRequests)));
    const loadImbalance = avgRequests > 0 ? (maxDeviation / avgRequests * 100) : 0;

    metrics.totalRequests = totalRequests;
    metrics.errorRate = errorRate.toFixed(2);
    metrics.retryRate = retryRate.toFixed(2);
    metrics.avgLatency = avgLatency;
    metrics.minLatency = minLatency;
    metrics.maxLatency = maxLatency;
    metrics.openCircuits = openCircuits;
    metrics.halfOpenCircuits = halfOpenCircuits;
    metrics.activeConnections = stats.activeConnections;
    metrics.loadImbalance = loadImbalance.toFixed(1);

    // Detect issues
    if (errorRate > THRESHOLDS.errorRatePercent) {
        issues.push(`HIGH_ERROR_RATE: ${errorRate.toFixed(1)}% (threshold: ${THRESHOLDS.errorRatePercent}%)`);
    }

    if (avgLatency > THRESHOLDS.avgLatencyMs) {
        issues.push(`HIGH_LATENCY: ${avgLatency}ms avg (threshold: ${THRESHOLDS.avgLatencyMs}ms)`);
    }

    if (openCircuits >= THRESHOLDS.circuitOpenCount) {
        issues.push(`CIRCUITS_OPEN: ${openCircuits} keys disabled`);
    }

    if (retryRate > THRESHOLDS.retryRatePercent) {
        issues.push(`HIGH_RETRY_RATE: ${retryRate.toFixed(1)}% (threshold: ${THRESHOLDS.retryRatePercent}%)`);
    }

    // Check for socket hangup spike (compare to previous)
    if (prevStats) {
        const hangupDelta = stats.errors.socketHangups - prevStats.errors.socketHangups;
        if (hangupDelta > THRESHOLDS.socketHangupSpike) {
            issues.push(`HANGUP_SPIKE: +${hangupDelta} in last interval`);
        }
    }

    // Check for stuck keys (high in-flight for too long)
    const stuckKeys = stats.keys.filter(k => k.inFlight > 5);
    if (stuckKeys.length > 0) {
        issues.push(`STUCK_KEYS: ${stuckKeys.map(k => `Key${k.index}(${k.inFlight})`).join(', ')}`);
    }

    return { metrics, issues };
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function printSummary(stats, analysis) {
    const { metrics, issues } = analysis;
    const uptime = formatDuration(stats.uptime * 1000);
    const monitorUptime = formatDuration(Date.now() - history.startTime);

    console.log('\n' + '='.repeat(60));
    console.log(`GLM PROXY MONITOR - ${new Date().toLocaleTimeString()}`);
    console.log('='.repeat(60));
    console.log(`Proxy Uptime: ${uptime} | Monitor Uptime: ${monitorUptime}`);
    console.log('-'.repeat(60));
    console.log(`Requests: ${metrics.totalRequests} | Active: ${metrics.activeConnections} | Errors: ${metrics.errorRate}% | Retries: ${metrics.retryRate}%`);
    console.log(`Latency: avg=${metrics.avgLatency}ms min=${metrics.minLatency}ms max=${metrics.maxLatency}ms`);
    console.log(`Circuits: ${10 - metrics.openCircuits - metrics.halfOpenCircuits} CLOSED, ${metrics.halfOpenCircuits} HALF_OPEN, ${metrics.openCircuits} OPEN`);
    console.log(`Load Balance: ${metrics.loadImbalance}% deviation`);

    // Key status summary
    console.log('-'.repeat(60));
    console.log('KEY STATUS:');
    stats.keys.forEach(k => {
        const status = k.state === 'CLOSED' ? '✓' : k.state === 'HALF_OPEN' ? '?' : '✗';
        const latency = k.avgLatency ? `${k.avgLatency}ms` : 'n/a';
        const error = k.lastError ? ` [${k.lastError}]` : '';
        console.log(`  ${status} Key${k.index}: ${k.total}req ${latency} inFlight=${k.inFlight}${error}`);
    });

    // Issues
    if (issues.length > 0) {
        console.log('-'.repeat(60));
        console.log('⚠️  ALERTS:');
        issues.forEach(issue => console.log(`  - ${issue}`));
        log(`ALERT: ${issues.join('; ')}`, 'WARN');
    } else {
        console.log('-'.repeat(60));
        console.log('✅ All systems healthy');
    }

    console.log('='.repeat(60) + '\n');
}

async function monitor() {
    let prevStats = null;
    let consecutiveFailures = 0;

    log('Monitor started');
    console.log('GLM Proxy Monitor started. Polling every 30 seconds...\n');

    const poll = async () => {
        try {
            const stats = await fetchStats();
            consecutiveFailures = 0;

            const analysis = analyzeStats(stats, prevStats);

            // Store in history
            history.samples.push({
                timestamp: Date.now(),
                metrics: analysis.metrics,
                issues: analysis.issues
            });
            if (history.samples.length > history.maxSamples) {
                history.samples.shift();
            }

            // Track alerts
            if (analysis.issues.length > 0) {
                history.alerts.push({
                    timestamp: Date.now(),
                    issues: analysis.issues
                });
            }

            printSummary(stats, analysis);
            prevStats = stats;

        } catch (err) {
            consecutiveFailures++;
            log(`Failed to fetch stats: ${err.message}`, 'ERROR');
            console.log(`\n❌ PROXY UNREACHABLE: ${err.message}`);

            if (consecutiveFailures >= 3) {
                console.log('⚠️  Proxy appears to be down! Check if it needs restart.');
            }
        }
    };

    // Initial poll
    await poll();

    // Continue polling
    const pollInterval = setInterval(poll, POLL_INTERVAL);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        clearInterval(pollInterval);
        log('Monitor stopped');
        console.log('\nMonitor stopped.');
        process.exit(0);
    });

// Start monitoring
monitor();
