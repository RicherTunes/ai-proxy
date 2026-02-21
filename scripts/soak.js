#!/usr/bin/env node
/**
 * Soak Test Runner
 *
 * Runs extended load tests with invariant assertions to catch:
 * - Memory leaks (heap growth)
 * - Event listener leaks
 * - SSE connection instability
 * - Error rate regressions
 *
 * Usage:
 *   node scripts/soak.js [options]
 *
 * Options:
 *   --proxyUrl=URL        Proxy URL (default: http://localhost:3000)
 *   --stubUrl=URL         Stub upstream URL (default: http://localhost:3001)
 *   --duration=N          Test duration in seconds (default: 1800 = 30min)
 *   --warmup=N            Warmup duration in seconds (default: 300 = 5min)
 *   --rps=N               Requests per second (default: 20)
 *   --concurrency=N       Max concurrent requests (default: 50)
 *   --heapMaxMbPerHour=N  Max heap growth MB/hour (default: 20)
 *   --scenario=NAME       Stub scenario (default: mixed)
 *   --sseReconnectMax=N   Max SSE reconnects allowed (default: 3)
 *   --errorRateMax=N      Max error rate % (default: 5)
 *   --outDir=PATH         Output directory (default: test-results/soak/<timestamp>)
 *   --sampleInterval=N    Heap sample interval in seconds (default: 30)
 *   --startServices       Start stub and proxy automatically
 *   --verbose             Verbose output
 *
 * Exit codes:
 *   0 - All invariants passed
 *   1 - One or more invariants failed
 *   2 - Setup/runtime error
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// Configuration with defaults
const config = {
    proxyUrl: process.env.SOAK_PROXY_URL || 'http://localhost:3000',
    stubUrl: process.env.SOAK_STUB_URL || 'http://localhost:3001',
    duration: parseInt(process.env.SOAK_DURATION || '1800'),
    warmup: parseInt(process.env.SOAK_WARMUP || '300'),
    rps: parseInt(process.env.SOAK_RPS || '20'),
    concurrency: parseInt(process.env.SOAK_CONCURRENCY || '50'),
    heapMaxMbPerHour: parseFloat(process.env.SOAK_HEAP_MAX_MB_HR || '20'),
    scenario: process.env.SOAK_SCENARIO || 'mixed',
    sseReconnectMax: parseInt(process.env.SOAK_SSE_RECONNECT_MAX || '3'),
    errorRateMax: parseFloat(process.env.SOAK_ERROR_RATE_MAX || '5'),
    outDir: null,
    sampleInterval: parseInt(process.env.SOAK_SAMPLE_INTERVAL || '30'),
    startServices: false,
    verbose: false
};

// Parse CLI args
process.argv.slice(2).forEach(arg => {
    if (arg === '--verbose') { config.verbose = true; return; }
    if (arg === '--startServices') { config.startServices = true; return; }
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'proxyUrl') config.proxyUrl = value;
    if (key === 'stubUrl') config.stubUrl = value;
    if (key === 'duration') config.duration = parseInt(value);
    if (key === 'warmup') config.warmup = parseInt(value);
    if (key === 'rps') config.rps = parseInt(value);
    if (key === 'concurrency') config.concurrency = parseInt(value);
    if (key === 'heapMaxMbPerHour') config.heapMaxMbPerHour = parseFloat(value);
    if (key === 'scenario') config.scenario = value;
    if (key === 'sseReconnectMax') config.sseReconnectMax = parseInt(value);
    if (key === 'errorRateMax') config.errorRateMax = parseFloat(value);
    if (key === 'outDir') config.outDir = value;
    if (key === 'sampleInterval') config.sampleInterval = parseInt(value);
});

// Set output directory
if (!config.outDir) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    config.outDir = path.join('test-results', 'soak', timestamp);
}

// Ensure output directory exists
fs.mkdirSync(config.outDir, { recursive: true });

// Logging
const logFile = fs.createWriteStream(path.join(config.outDir, 'soak.log'));
function log(msg, level = 'INFO') {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
    logFile.write(line + '\n');
}

function logVerbose(msg) {
    if (config.verbose) log(msg, 'DEBUG');
}

// Soak test state
const state = {
    phase: 'init',
    startTime: null,
    warmupEndTime: null,
    endTime: null,

    // Heap tracking
    heapSamples: [],
    heapGrowthMbPerHour: null,

    // SSE tracking
    sseConnected: false,
    sseReconnects: 0,
    sseDisconnects: 0,
    sseLastEventTime: null,
    sseEventCount: 0,

    // Load metrics (from load.js-style tracking)
    requests: 0,
    successes: 0,
    errors: { total: 0, byCode: {}, byType: {} },
    latencies: [],

    // Proxy stats snapshots
    proxyStatsHistory: [],

    // Warnings detected
    warnings: [],

    // Invariant results
    invariants: {
        heapGrowth: { passed: null, value: null, threshold: null },
        sseStability: { passed: null, reconnects: null, threshold: null },
        errorRate: { passed: null, value: null, threshold: null },
        listenerLeaks: { passed: null, warnings: [] }
    }
};

// Child processes
let stubProcess = null;
let proxyProcess = null;
let sseClient = null;

// HTTP helper
function httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const req = client.request(url, {
            method: options.method || 'GET',
            headers: options.headers || {},
            timeout: options.timeout || 10000
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, body, headers: res.headers });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });

        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

// Start stub upstream
async function startStub() {
    log('Starting stub upstream server...');

    // Build args - pass through environment-based config
    const stubArgs = [
        'scripts/stub-upstream.js',
        `--port=${new URL(config.stubUrl).port || 3001}`,
        `--scenario=${config.scenario}`
    ];

    // Pass through stub env vars for seeded RNG and error rates
    const stubEnv = { ...process.env };

    stubProcess = spawn('node', stubArgs, {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: stubEnv  // Inherits STUB_SEED, STUB_429_RATE, etc.
    });

    stubProcess.stdout.on('data', data => logVerbose(`[stub] ${data.toString().trim()}`));
    stubProcess.stderr.on('data', data => log(`[stub] ${data.toString().trim()}`, 'ERROR'));

    // Wait for stub to be ready
    for (let i = 0; i < 30; i++) {
        try {
            await httpRequest(`${config.stubUrl}/_stub/health`);
            log('Stub upstream ready');
            return;
        } catch (e) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw new Error('Stub upstream failed to start');
}

// Start proxy
async function startProxy() {
    log('Starting proxy server...');
    proxyProcess = spawn('node', ['proxy.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            GLM_UPSTREAM_URL: config.stubUrl,
            PORT: new URL(config.proxyUrl).port || 3000
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const proxyLog = fs.createWriteStream(path.join(config.outDir, 'proxy.log'));
    proxyProcess.stdout.pipe(proxyLog);
    proxyProcess.stderr.pipe(proxyLog);

    // Wait for proxy to be ready
    for (let i = 0; i < 30; i++) {
        try {
            await httpRequest(`${config.proxyUrl}/health`);
            log('Proxy ready');
            return;
        } catch (e) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw new Error('Proxy failed to start');
}

// SSE client for stability monitoring
function startSseClient() {
    log('Starting SSE client for stability monitoring...');

    function connect() {
        const url = new URL('/dashboard/stream', config.proxyUrl);
        const client = url.protocol === 'https:' ? https : http;

        const req = client.request(url, {
            headers: { 'Accept': 'text/event-stream' }
        }, (res) => {
            if (res.statusCode !== 200) {
                log(`SSE connection failed with status ${res.statusCode}`, 'WARN');
                scheduleReconnect();
                return;
            }

            state.sseConnected = true;
            log('SSE connected');

            res.on('data', chunk => {
                state.sseLastEventTime = Date.now();
                const lines = chunk.toString().split('\n');
                for (const line of lines) {
                    if (line.startsWith('data:')) {
                        state.sseEventCount++;
                    }
                }
            });

            res.on('end', () => {
                state.sseConnected = false;
                state.sseDisconnects++;
                log('SSE disconnected', 'WARN');
                scheduleReconnect();
            });

            res.on('error', (err) => {
                state.sseConnected = false;
                state.sseDisconnects++;
                log(`SSE error: ${err.message}`, 'WARN');
                scheduleReconnect();
            });
        });

        req.on('error', (err) => {
            state.sseConnected = false;
            log(`SSE connection error: ${err.message}`, 'WARN');
            scheduleReconnect();
        });

        req.end();
        sseClient = req;
    }

    function scheduleReconnect() {
        if (state.phase === 'done') return;
        state.sseReconnects++;
        log(`SSE reconnect attempt ${state.sseReconnects}`);
        setTimeout(connect, 2000);
    }

    connect();
}

// Sample heap usage
function sampleHeap() {
    const usage = process.memoryUsage();
    state.heapSamples.push({
        timestamp: Date.now(),
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external,
        rss: usage.rss
    });

    logVerbose(`Heap: ${Math.round(usage.heapUsed / 1024 / 1024)}MB used, ${Math.round(usage.rss / 1024 / 1024)}MB RSS`);
}

// Poll proxy stats
async function pollProxyStats() {
    try {
        const res = await httpRequest(`${config.proxyUrl}/stats`);
        const stats = JSON.parse(res.body);

        state.proxyStatsHistory.push({
            timestamp: Date.now(),
            stats
        });

        // Check for EventEmitter warnings in stats or logs
        if (stats.warnings && stats.warnings.length > 0) {
            for (const warning of stats.warnings) {
                if (warning.includes('EventEmitter') || warning.includes('memory leak')) {
                    state.warnings.push({ timestamp: Date.now(), warning });
                    log(`EventEmitter warning detected: ${warning}`, 'WARN');
                }
            }
        }

        logVerbose(`Proxy stats: ${stats.totals?.requests || 0} requests, ${stats.totals?.errors || 0} errors`);
    } catch (e) {
        logVerbose(`Failed to poll proxy stats: ${e.message}`);
    }
}

// Request payload
const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'Soak test request' }],
    max_tokens: 100
});

// Make a single request (similar to load.js)
function makeRequest() {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const url = new URL('/v1/chat/completions', config.proxyUrl);
        const client = url.protocol === 'https:' ? https : http;

        const req = client.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'Authorization': 'Bearer soak-test-key'
            },
            timeout: 30000
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const latency = Date.now() - startTime;
                state.requests++;
                state.latencies.push(latency);

                if (res.statusCode >= 200 && res.statusCode < 300) {
                    state.successes++;
                } else {
                    state.errors.total++;
                    state.errors.byCode[res.statusCode] = (state.errors.byCode[res.statusCode] || 0) + 1;
                }
                resolve({ statusCode: res.statusCode, latency });
            });
        });

        req.on('error', (err) => {
            const latency = Date.now() - startTime;
            state.requests++;
            state.errors.total++;
            state.latencies.push(latency);
            const errType = err.code || 'unknown';
            state.errors.byType[errType] = (state.errors.byType[errType] || 0) + 1;
            resolve({ error: errType, latency });
        });

        req.on('timeout', () => {
            req.destroy();
            state.requests++;
            state.errors.total++;
            state.errors.byType['TIMEOUT'] = (state.errors.byType['TIMEOUT'] || 0) + 1;
            resolve({ error: 'TIMEOUT', latency: 30000 });
        });

        req.write(requestBody);
        req.end();
    });
}

// Rate limiter
class RateLimiter {
    constructor(rps) {
        this.rps = rps;
        this.tokens = rps;
        this.lastRefill = Date.now();
    }

    async acquire() {
        while (true) {
            const now = Date.now();
            const elapsed = (now - this.lastRefill) / 1000;
            this.tokens = Math.min(this.rps, this.tokens + elapsed * this.rps);
            this.lastRefill = now;

            if (this.tokens >= 1) {
                this.tokens--;
                return;
            }
            await new Promise(r => setTimeout(r, 10));
        }
    }
}

// Concurrency limiter
class ConcurrencyLimiter {
    constructor(max) {
        this.max = max;
        this.current = 0;
        this.waiting = [];
    }

    async acquire() {
        if (this.current < this.max) {
            this.current++;
            return;
        }
        await new Promise(resolve => this.waiting.push(resolve));
        this.current++;
    }

    release() {
        this.current--;
        if (this.waiting.length > 0) {
            const next = this.waiting.shift();
            next();
        }
    }
}

// Calculate heap growth slope
function calculateHeapGrowth() {
    // Only use samples from measurement phase
    const measurementSamples = state.heapSamples.filter(
        s => s.timestamp >= state.warmupEndTime
    );

    if (measurementSamples.length < 2) {
        return { slope: 0, r2: 0 };
    }

    // Linear regression
    const n = measurementSamples.length;
    const xs = measurementSamples.map(s => (s.timestamp - measurementSamples[0].timestamp) / 1000 / 3600); // hours
    const ys = measurementSamples.map(s => s.heapUsed / 1024 / 1024); // MB

    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((sum, x, i) => sum + x * ys[i], 0);
    const sumX2 = xs.reduce((sum, x) => sum + x * x, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // R-squared
    const meanY = sumY / n;
    const ssTotal = ys.reduce((sum, y) => sum + Math.pow(y - meanY, 2), 0);
    const ssRes = ys.reduce((sum, y, i) => sum + Math.pow(y - (meanY + slope * (xs[i] - sumX / n)), 2), 0);
    const r2 = 1 - (ssRes / ssTotal);

    return { slope, r2 };
}

// Percentile calculation
function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

// Check invariants
function checkInvariants() {
    const results = state.invariants;
    let allPassed = true;

    // 1. Heap growth
    const heapGrowth = calculateHeapGrowth();
    state.heapGrowthMbPerHour = heapGrowth.slope;
    results.heapGrowth = {
        passed: heapGrowth.slope <= config.heapMaxMbPerHour,
        value: Math.round(heapGrowth.slope * 100) / 100,
        threshold: config.heapMaxMbPerHour,
        r2: Math.round(heapGrowth.r2 * 1000) / 1000
    };
    if (!results.heapGrowth.passed) {
        log(`FAIL: Heap growth ${results.heapGrowth.value} MB/hr exceeds threshold ${config.heapMaxMbPerHour} MB/hr`, 'ERROR');
        allPassed = false;
    } else {
        log(`PASS: Heap growth ${results.heapGrowth.value} MB/hr within threshold`);
    }

    // 2. SSE stability
    results.sseStability = {
        passed: state.sseReconnects <= config.sseReconnectMax,
        reconnects: state.sseReconnects,
        threshold: config.sseReconnectMax,
        totalEvents: state.sseEventCount
    };
    if (!results.sseStability.passed) {
        log(`FAIL: SSE reconnects ${state.sseReconnects} exceeds threshold ${config.sseReconnectMax}`, 'ERROR');
        allPassed = false;
    } else {
        log(`PASS: SSE stability - ${state.sseReconnects} reconnects, ${state.sseEventCount} events`);
    }

    // 3. Error rate
    const errorRate = state.requests > 0 ? (state.errors.total / state.requests) * 100 : 0;
    results.errorRate = {
        passed: errorRate <= config.errorRateMax,
        value: Math.round(errorRate * 100) / 100,
        threshold: config.errorRateMax,
        totalRequests: state.requests,
        totalErrors: state.errors.total
    };
    if (!results.errorRate.passed) {
        log(`FAIL: Error rate ${results.errorRate.value}% exceeds threshold ${config.errorRateMax}%`, 'ERROR');
        allPassed = false;
    } else {
        log(`PASS: Error rate ${results.errorRate.value}% within threshold`);
    }

    // 4. Listener leaks
    results.listenerLeaks = {
        passed: state.warnings.length === 0,
        warnings: state.warnings
    };
    if (!results.listenerLeaks.passed) {
        log(`FAIL: Detected ${state.warnings.length} EventEmitter leak warnings`, 'ERROR');
        allPassed = false;
    } else {
        log('PASS: No EventEmitter leak warnings detected');
    }

    return allPassed;
}

// Generate final report
function generateReport() {
    const duration = (state.endTime - state.warmupEndTime) / 1000;
    const totalDuration = (state.endTime - state.startTime) / 1000;

    return {
        config: { ...config, outDir: undefined },
        timing: {
            startTime: new Date(state.startTime).toISOString(),
            warmupEndTime: new Date(state.warmupEndTime).toISOString(),
            endTime: new Date(state.endTime).toISOString(),
            warmupDuration: config.warmup,
            measurementDuration: Math.round(duration),
            totalDuration: Math.round(totalDuration)
        },
        summary: {
            totalRequests: state.requests,
            successfulRequests: state.successes,
            failedRequests: state.errors.total,
            successRate: state.requests > 0 ? Math.round((state.successes / state.requests) * 10000) / 100 : 0,
            throughput: Math.round((state.requests / duration) * 100) / 100
        },
        latency: {
            min: Math.min(...state.latencies) || 0,
            max: Math.max(...state.latencies) || 0,
            avg: Math.round(state.latencies.reduce((a, b) => a + b, 0) / state.latencies.length) || 0,
            p50: percentile(state.latencies, 50),
            p95: percentile(state.latencies, 95),
            p99: percentile(state.latencies, 99)
        },
        errors: {
            total: state.errors.total,
            byStatusCode: state.errors.byCode,
            byType: state.errors.byType
        },
        heap: {
            growthMbPerHour: state.heapGrowthMbPerHour,
            samples: state.heapSamples.length,
            initialMb: state.heapSamples.length > 0 ? Math.round(state.heapSamples[0].heapUsed / 1024 / 1024) : 0,
            finalMb: state.heapSamples.length > 0 ? Math.round(state.heapSamples[state.heapSamples.length - 1].heapUsed / 1024 / 1024) : 0
        },
        sse: {
            connected: state.sseConnected,
            reconnects: state.sseReconnects,
            disconnects: state.sseDisconnects,
            totalEvents: state.sseEventCount
        },
        invariants: state.invariants,
        passed: Object.values(state.invariants).every(i => i.passed)
    };
}

// Main soak test runner
async function runSoak() {
    log('=' .repeat(60));
    log('Soak Test Configuration');
    log('='.repeat(60));
    log(`Proxy URL:    ${config.proxyUrl}`);
    log(`Stub URL:     ${config.stubUrl}`);
    log(`Duration:     ${config.duration}s (${Math.round(config.duration / 60)}min)`);
    log(`Warmup:       ${config.warmup}s (${Math.round(config.warmup / 60)}min)`);
    log(`RPS:          ${config.rps}`);
    log(`Concurrency:  ${config.concurrency}`);
    log(`Scenario:     ${config.scenario}`);
    log(`Heap Max:     ${config.heapMaxMbPerHour} MB/hr`);
    log(`Output:       ${config.outDir}`);
    log('='.repeat(60));

    try {
        // Start services if requested
        if (config.startServices) {
            await startStub();
            await startProxy();
        } else {
            // Verify services are running
            log('Verifying services are running...');
            try {
                await httpRequest(`${config.stubUrl}/_stub/health`);
                log('Stub upstream: OK');
            } catch (e) {
                log(`Stub upstream not reachable: ${e.message}`, 'ERROR');
                throw new Error('Stub upstream not running. Use --startServices or start manually.');
            }

            try {
                await httpRequest(`${config.proxyUrl}/health`);
                log('Proxy: OK');
            } catch (e) {
                log(`Proxy not reachable: ${e.message}`, 'ERROR');
                throw new Error('Proxy not running. Use --startServices or start manually.');
            }
        }

        // Configure stub scenario
        log(`Configuring stub for scenario: ${config.scenario}`);
        await httpRequest(`${config.stubUrl}/_stub/config`, {
            method: 'POST',
            body: { scenario: config.scenario },
            headers: { 'Content-Type': 'application/json' }
        });

        // Reset stub stats
        await httpRequest(`${config.stubUrl}/_stub/reset`, { method: 'POST' });

        // Start SSE monitoring
        startSseClient();

        // Start heap sampling
        const heapInterval = setInterval(sampleHeap, config.sampleInterval * 1000);
        sampleHeap(); // Initial sample

        // Start stats polling
        const statsInterval = setInterval(pollProxyStats, 30000);
        await pollProxyStats(); // Initial poll

        // Initialize rate/concurrency limiters
        const rateLimiter = new RateLimiter(config.rps);
        const concurrencyLimiter = new ConcurrencyLimiter(config.concurrency);

        state.startTime = Date.now();
        state.phase = 'warmup';
        log('\n--- WARMUP PHASE ---');

        // Progress reporter
        let lastReport = Date.now();
        const progressInterval = setInterval(() => {
            const elapsed = (Date.now() - state.startTime) / 1000;
            const phase = state.phase;
            const rps = state.requests / elapsed;
            const errRate = state.requests > 0 ? (state.errors.total / state.requests) * 100 : 0;
            const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

            process.stdout.write(`\r[${Math.round(elapsed)}s] [${phase}] Requests: ${state.requests} | RPS: ${Math.round(rps)} | Errors: ${errRate.toFixed(1)}% | Heap: ${heapMb}MB | SSE: ${state.sseEventCount} events     `);
            lastReport = Date.now();
        }, 1000);

        // Warmup phase
        const warmupEnd = Date.now() + config.warmup * 1000;
        while (Date.now() < warmupEnd) {
            await rateLimiter.acquire();
            await concurrencyLimiter.acquire();
            makeRequest().finally(() => concurrencyLimiter.release());
        }

        // Reset stats for measurement phase
        state.warmupEndTime = Date.now();
        state.requests = 0;
        state.successes = 0;
        state.errors = { total: 0, byCode: {}, byType: {} };
        state.latencies = [];

        state.phase = 'measurement';
        log('\n\n--- MEASUREMENT PHASE ---');

        // Measurement phase
        const measurementEnd = Date.now() + config.duration * 1000;
        while (Date.now() < measurementEnd) {
            await rateLimiter.acquire();
            await concurrencyLimiter.acquire();
            makeRequest().finally(() => concurrencyLimiter.release());
        }

        // Wait for in-flight requests
        log('\n\nWaiting for in-flight requests...');
        await new Promise(r => setTimeout(r, 5000));

        state.endTime = Date.now();
        state.phase = 'done';

        // Stop intervals
        clearInterval(heapInterval);
        clearInterval(statsInterval);
        clearInterval(progressInterval);

        // Close SSE client
        if (sseClient) {
            sseClient.destroy();
        }

        // Final samples
        sampleHeap();
        await pollProxyStats();

        // Get stub stats
        let stubStats = null;
        try {
            const res = await httpRequest(`${config.stubUrl}/_stub/stats`);
            stubStats = JSON.parse(res.body);
        } catch (e) {
            log(`Failed to get stub stats: ${e.message}`, 'WARN');
        }

        // Check invariants
        log('\n' + '='.repeat(60));
        log('Checking Invariants');
        log('='.repeat(60));
        const allPassed = checkInvariants();

        // Generate report
        const report = generateReport();

        // Write artifacts
        log('\n' + '='.repeat(60));
        log('Writing Artifacts');
        log('='.repeat(60));

        // Main report
        fs.writeFileSync(
            path.join(config.outDir, 'soak.json'),
            JSON.stringify(report, null, 2)
        );
        log(`Report: ${path.join(config.outDir, 'soak.json')}`);

        // Heap timeseries
        fs.writeFileSync(
            path.join(config.outDir, 'heap-samples.json'),
            JSON.stringify(state.heapSamples, null, 2)
        );
        log(`Heap samples: ${path.join(config.outDir, 'heap-samples.json')}`);

        // Proxy stats history
        fs.writeFileSync(
            path.join(config.outDir, 'proxy-stats-history.json'),
            JSON.stringify(state.proxyStatsHistory, null, 2)
        );
        log(`Proxy stats: ${path.join(config.outDir, 'proxy-stats-history.json')}`);

        // Stub stats
        if (stubStats) {
            fs.writeFileSync(
                path.join(config.outDir, 'stub-stats.json'),
                JSON.stringify(stubStats, null, 2)
            );
            log(`Stub stats: ${path.join(config.outDir, 'stub-stats.json')}`);
        }

        // Summary
        log('\n' + '='.repeat(60));
        log('SOAK TEST SUMMARY');
        log('='.repeat(60));
        log(`Duration:        ${Math.round((state.endTime - state.warmupEndTime) / 1000)}s`);
        log(`Total Requests:  ${report.summary.totalRequests}`);
        log(`Success Rate:    ${report.summary.successRate}%`);
        log(`Throughput:      ${report.summary.throughput} req/s`);
        log(`Latency P50:     ${report.latency.p50}ms`);
        log(`Latency P99:     ${report.latency.p99}ms`);
        log(`Heap Growth:     ${report.heap.growthMbPerHour} MB/hr`);
        log(`SSE Reconnects:  ${report.sse.reconnects}`);
        log('');
        log(`RESULT: ${allPassed ? 'PASSED' : 'FAILED'}`);
        log('='.repeat(60));

        // Cleanup
        if (stubProcess) stubProcess.kill();
        if (proxyProcess) proxyProcess.kill();
        logFile.end();

        return allPassed ? 0 : 1;

    } catch (err) {
        log(`Soak test error: ${err.message}`, 'ERROR');
        log(err.stack, 'ERROR');

        if (stubProcess) stubProcess.kill();
        if (proxyProcess) proxyProcess.kill();
        logFile.end();

        return 2;
    }
}

// Handle signals
process.on('SIGINT', () => {
    log('\nInterrupted. Generating partial results...');
    state.endTime = Date.now();
    state.phase = 'done';

    if (sseClient) sseClient.destroy();

    const report = generateReport();
    fs.writeFileSync(
        path.join(config.outDir, 'soak-partial.json'),
        JSON.stringify(report, null, 2)
    );

    if (stubProcess) stubProcess.kill();
    if (proxyProcess) proxyProcess.kill();
    logFile.end();

    process.exit(1);
});

// Run if called directly
if (require.main === module) {
    runSoak().then(code => {
        process.exit(code);
    });
}

module.exports = { runSoak, config };
