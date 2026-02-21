#!/usr/bin/env node
/**
 * Load Generator
 *
 * Generates configurable load against the proxy server for testing.
 *
 * Usage:
 *   node scripts/load.js [options]
 *
 * Options:
 *   --target=URL       Target URL (default: http://localhost:3000)
 *   --rps=N            Requests per second (default: 10)
 *   --concurrency=N    Max concurrent requests (default: 10)
 *   --duration=N       Test duration in seconds (default: 60)
 *   --route=PATH       Route to test (default: /v1/chat/completions)
 *   --warmup=N         Warmup seconds before measuring (default: 5)
 *   --output=FILE      Output JSON results to file
 *   --verbose          Print each request result
 *
 * Output:
 *   JSON summary with latency percentiles, error rates, throughput
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Configuration
const config = {
    target: process.env.LOAD_TARGET || 'http://localhost:3000',
    rps: parseInt(process.env.LOAD_RPS || '10'),
    concurrency: parseInt(process.env.LOAD_CONCURRENCY || '10'),
    duration: parseInt(process.env.LOAD_DURATION || '60'),
    route: process.env.LOAD_ROUTE || '/v1/chat/completions',
    warmup: parseInt(process.env.LOAD_WARMUP || '5'),
    output: null,
    verbose: false
};

// Parse CLI args
process.argv.slice(2).forEach(arg => {
    if (arg === '--verbose') {
        config.verbose = true;
        return;
    }
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'target') config.target = value;
    if (key === 'rps') config.rps = parseInt(value);
    if (key === 'concurrency') config.concurrency = parseInt(value);
    if (key === 'duration') config.duration = parseInt(value);
    if (key === 'route') config.route = value;
    if (key === 'warmup') config.warmup = parseInt(value);
    if (key === 'output') config.output = value;
});

// Stats collection
const stats = {
    requests: 0,
    successes: 0,
    errors: {
        total: 0,
        byCode: {},
        byType: {}
    },
    latencies: [],
    startTime: null,
    endTime: null,
    inFlight: 0,
    maxInFlight: 0
};

// Request payload
const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    messages: [
        { role: 'user', content: 'Hello, this is a load test request.' }
    ],
    max_tokens: 100
});

// Make a single request
function makeRequest() {
    return new Promise((resolve) => {
        const startTime = Date.now();
        stats.inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);

        const url = new URL(config.route, config.target);
        const client = url.protocol === 'https:' ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'Authorization': 'Bearer test-key',
                'x-request-id': `load-${Date.now()}-${Math.random().toString(36).slice(2)}`
            },
            timeout: 30000
        };

        const req = client.request(options, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                const latency = Date.now() - startTime;
                stats.inFlight--;
                stats.requests++;
                stats.latencies.push(latency);

                if (res.statusCode >= 200 && res.statusCode < 300) {
                    stats.successes++;
                    if (config.verbose) {
                        console.log(`✓ ${res.statusCode} ${latency}ms`);
                    }
                } else {
                    stats.errors.total++;
                    stats.errors.byCode[res.statusCode] = (stats.errors.byCode[res.statusCode] || 0) + 1;
                    if (config.verbose) {
                        console.log(`✗ ${res.statusCode} ${latency}ms`);
                    }
                }

                resolve({ statusCode: res.statusCode, latency, body });
            });
        });

        req.on('error', (err) => {
            const latency = Date.now() - startTime;
            stats.inFlight--;
            stats.requests++;
            stats.errors.total++;
            stats.latencies.push(latency);

            const errType = err.code || err.message || 'unknown';
            stats.errors.byType[errType] = (stats.errors.byType[errType] || 0) + 1;

            if (config.verbose) {
                console.log(`✗ ${errType} ${latency}ms`);
            }

            resolve({ error: errType, latency });
        });

        req.on('timeout', () => {
            req.destroy();
            const latency = Date.now() - startTime;
            stats.inFlight--;
            stats.requests++;
            stats.errors.total++;
            stats.latencies.push(latency);
            stats.errors.byType['TIMEOUT'] = (stats.errors.byType['TIMEOUT'] || 0) + 1;

            if (config.verbose) {
                console.log(`✗ TIMEOUT ${latency}ms`);
            }

            resolve({ error: 'TIMEOUT', latency });
        });

        req.write(requestBody);
        req.end();
    });
}

// Calculate percentile
function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

// Generate results summary
function generateSummary() {
    const duration = (stats.endTime - stats.startTime) / 1000;
    const throughput = stats.requests / duration;
    const successRate = stats.requests > 0 ? (stats.successes / stats.requests) * 100 : 0;

    return {
        config: {
            target: config.target,
            route: config.route,
            rps: config.rps,
            concurrency: config.concurrency,
            duration: config.duration
        },
        summary: {
            totalRequests: stats.requests,
            successfulRequests: stats.successes,
            failedRequests: stats.errors.total,
            successRate: Math.round(successRate * 100) / 100,
            actualDuration: Math.round(duration * 100) / 100,
            throughput: Math.round(throughput * 100) / 100,
            maxConcurrency: stats.maxInFlight
        },
        latency: {
            min: Math.min(...stats.latencies) || 0,
            max: Math.max(...stats.latencies) || 0,
            avg: Math.round(stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length) || 0,
            p50: percentile(stats.latencies, 50),
            p95: percentile(stats.latencies, 95),
            p99: percentile(stats.latencies, 99)
        },
        errors: {
            total: stats.errors.total,
            byStatusCode: stats.errors.byCode,
            byType: stats.errors.byType
        },
        timestamp: new Date().toISOString()
    };
}

// Rate limiter - simple token bucket
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

            // Wait for next token
            await new Promise(resolve => setTimeout(resolve, 10));
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

// Main load test runner
async function runLoadTest() {
    console.log('='.repeat(60));
    console.log('Load Test Configuration');
    console.log('='.repeat(60));
    console.log(`Target:      ${config.target}${config.route}`);
    console.log(`RPS:         ${config.rps}`);
    console.log(`Concurrency: ${config.concurrency}`);
    console.log(`Duration:    ${config.duration}s`);
    console.log(`Warmup:      ${config.warmup}s`);
    console.log('='.repeat(60));

    const rateLimiter = new RateLimiter(config.rps);
    const concurrencyLimiter = new ConcurrencyLimiter(config.concurrency);

    let running = true;
    const endTime = Date.now() + (config.duration + config.warmup) * 1000;

    // Progress reporter
    const progressInterval = setInterval(() => {
        const elapsed = (Date.now() - stats.startTime) / 1000;
        const rps = stats.requests / elapsed;
        const errRate = stats.requests > 0 ? (stats.errors.total / stats.requests) * 100 : 0;
        process.stdout.write(`\r[${Math.round(elapsed)}s] Requests: ${stats.requests} | RPS: ${Math.round(rps)} | Errors: ${stats.errors.total} (${errRate.toFixed(1)}%) | InFlight: ${stats.inFlight}     `);
    }, 1000);

    // Warmup phase
    if (config.warmup > 0) {
        console.log(`\nWarmup phase (${config.warmup}s)...`);
        const warmupEnd = Date.now() + config.warmup * 1000;
        while (Date.now() < warmupEnd && running) {
            await rateLimiter.acquire();
            await concurrencyLimiter.acquire();
            makeRequest().finally(() => concurrencyLimiter.release());
        }
        // Reset stats after warmup
        stats.requests = 0;
        stats.successes = 0;
        stats.errors = { total: 0, byCode: {}, byType: {} };
        stats.latencies = [];
        console.log('\nWarmup complete. Starting measurement...');
    }

    stats.startTime = Date.now();

    // Main test phase
    while (Date.now() < endTime && running) {
        await rateLimiter.acquire();
        await concurrencyLimiter.acquire();
        makeRequest().finally(() => concurrencyLimiter.release());
    }

    // Wait for in-flight requests
    console.log('\n\nWaiting for in-flight requests...');
    while (stats.inFlight > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    stats.endTime = Date.now();
    clearInterval(progressInterval);

    // Generate summary
    const summary = generateSummary();

    console.log('\n' + '='.repeat(60));
    console.log('Results Summary');
    console.log('='.repeat(60));
    console.log(`Total Requests:    ${summary.summary.totalRequests}`);
    console.log(`Successful:        ${summary.summary.successfulRequests}`);
    console.log(`Failed:            ${summary.summary.failedRequests}`);
    console.log(`Success Rate:      ${summary.summary.successRate}%`);
    console.log(`Throughput:        ${summary.summary.throughput} req/s`);
    console.log(`Max Concurrency:   ${summary.summary.maxConcurrency}`);
    console.log('');
    console.log('Latency (ms):');
    console.log(`  Min:  ${summary.latency.min}`);
    console.log(`  Avg:  ${summary.latency.avg}`);
    console.log(`  P50:  ${summary.latency.p50}`);
    console.log(`  P95:  ${summary.latency.p95}`);
    console.log(`  P99:  ${summary.latency.p99}`);
    console.log(`  Max:  ${summary.latency.max}`);

    if (Object.keys(summary.errors.byStatusCode).length > 0) {
        console.log('');
        console.log('Errors by Status Code:');
        for (const [code, count] of Object.entries(summary.errors.byStatusCode)) {
            console.log(`  ${code}: ${count}`);
        }
    }

    if (Object.keys(summary.errors.byType).length > 0) {
        console.log('');
        console.log('Errors by Type:');
        for (const [type, count] of Object.entries(summary.errors.byType)) {
            console.log(`  ${type}: ${count}`);
        }
    }

    console.log('='.repeat(60));

    // Output to file if requested
    if (config.output) {
        const fs = require('fs');
        const path = require('path');
        const dir = path.dirname(config.output);
        if (dir && dir !== '.') {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(config.output, JSON.stringify(summary, null, 2));
        console.log(`Results written to: ${config.output}`);
    }

    return summary;
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\nInterrupted. Generating partial results...');
    stats.endTime = Date.now();
    const summary = generateSummary();
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
});

// Run if called directly
if (require.main === module) {
    runLoadTest().then(summary => {
        // Exit with error if success rate below threshold
        if (summary.summary.successRate < 95) {
            console.log('\n⚠️  Success rate below 95% threshold');
            process.exit(1);
        }
        process.exit(0);
    }).catch(err => {
        console.error('Load test failed:', err);
        process.exit(1);
    });
}

module.exports = { runLoadTest, config };
