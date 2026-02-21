#!/usr/bin/env node
/**
 * Performance Baseline Validator
 *
 * Runs load tests and validates results against baseline thresholds.
 * Exits with error code 1 if baselines are not met.
 *
 * Usage:
 *   node scripts/validate-baseline.js [profile] [options]
 *
 * Profiles:
 *   smoke     Quick validation (30s, 5 RPS) - default for CI
 *   standard  Standard load test (120s, 20 RPS)
 *   stress    High-load stress test (300s, 50 RPS)
 *   soak      Long-running soak test (1hr, 10 RPS)
 *
 * Options:
 *   --target=URL     Target URL (default: http://localhost:3000)
 *   --output=FILE    Output results to JSON file
 *   --verbose        Print detailed results
 *   --dry-run        Show config without running tests
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Load baseline configuration
const baselineConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../config/performance-baseline.json'), 'utf8')
);

// Parse arguments
const args = process.argv.slice(2);
const profile = args.find(a => !a.startsWith('--')) || 'smoke';
const options = {
    target: 'http://localhost:3000',
    output: null,
    verbose: false,
    dryRun: false
};

args.forEach(arg => {
    if (arg === '--verbose') options.verbose = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--target=')) options.target = arg.split('=')[1];
    else if (arg.startsWith('--output=')) options.output = arg.split('=')[1];
});

// Get profile configuration
const profileConfig = baselineConfig.profiles[profile];
if (!profileConfig) {
    console.error(`Unknown profile: ${profile}`);
    console.error(`Available profiles: ${Object.keys(baselineConfig.profiles).join(', ')}`);
    process.exit(1);
}

console.log(`\n========================================`);
console.log(`Performance Baseline Validation`);
console.log(`========================================`);
console.log(`Profile: ${profile}`);
console.log(`Description: ${profileConfig.description}`);
console.log(`Target: ${options.target}`);
console.log(`Duration: ${profileConfig.duration}s`);
console.log(`RPS: ${profileConfig.rps}`);
console.log(`Concurrency: ${profileConfig.concurrency}`);
console.log(`Warmup: ${profileConfig.warmup}s`);
console.log(`----------------------------------------\n`);

if (options.dryRun) {
    console.log('Thresholds:');
    console.log(JSON.stringify(profileConfig.thresholds, null, 2));
    process.exit(0);
}

// Stats collection
const stats = {
    requests: 0,
    successes: 0,
    errors: { total: 0, byCode: {}, byType: {} },
    latencies: [],
    startTime: null,
    endTime: null,
    inFlight: 0,
    maxInFlight: 0,
    memorySnapshots: []
};

// Request payload
const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'Load test request.' }],
    max_tokens: 50
});

// Make a single request
function makeRequest() {
    return new Promise((resolve) => {
        const startTime = Date.now();
        stats.inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);

        const url = new URL('/v1/chat/completions', options.target);
        const client = url.protocol === 'https:' ? https : http;

        const req = client.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'Authorization': 'Bearer test-key'
            },
            timeout: 30000
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const latency = Date.now() - startTime;
                stats.inFlight--;
                stats.requests++;
                stats.latencies.push(latency);

                if (res.statusCode >= 200 && res.statusCode < 300) {
                    stats.successes++;
                } else {
                    stats.errors.total++;
                    stats.errors.byCode[res.statusCode] = (stats.errors.byCode[res.statusCode] || 0) + 1;
                }
                resolve({ statusCode: res.statusCode, latency });
            });
        });

        req.on('error', (err) => {
            const latency = Date.now() - startTime;
            stats.inFlight--;
            stats.requests++;
            stats.errors.total++;
            stats.latencies.push(latency);
            stats.errors.byType[err.code || 'unknown'] = (stats.errors.byType[err.code || 'unknown'] || 0) + 1;
            resolve({ error: err.code, latency });
        });

        req.on('timeout', () => {
            req.destroy();
            stats.inFlight--;
            stats.requests++;
            stats.errors.total++;
            stats.errors.byType['TIMEOUT'] = (stats.errors.byType['TIMEOUT'] || 0) + 1;
            resolve({ error: 'TIMEOUT', latency: 30000 });
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

// Collect memory snapshot
function collectMemorySnapshot() {
    const mem = process.memoryUsage();
    stats.memorySnapshots.push({
        timestamp: Date.now(),
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss
    });
}

// Run load test
async function runLoadTest() {
    const { duration, rps, warmup } = profileConfig;
    const interval = 1000 / rps;
    const totalRequests = rps * duration;

    console.log(`Starting load test...`);
    console.log(`Target requests: ${totalRequests}`);
    console.log(`Warmup: ${warmup}s\n`);

    stats.startTime = Date.now();
    let requestsSent = 0;
    let isWarmup = true;

    // Memory collection interval
    const memoryInterval = setInterval(collectMemorySnapshot, 5000);
    collectMemorySnapshot();

    // Request generator
    const generator = setInterval(() => {
        const elapsed = (Date.now() - stats.startTime) / 1000;

        // Check if warmup is over
        if (isWarmup && elapsed >= warmup) {
            isWarmup = false;
            // Reset stats after warmup
            stats.requests = 0;
            stats.successes = 0;
            stats.errors = { total: 0, byCode: {}, byType: {} };
            stats.latencies = [];
            stats.startTime = Date.now();
            console.log(`Warmup complete. Starting measurement phase...`);
        }

        // Check if test is complete
        if (elapsed >= duration + warmup) {
            clearInterval(generator);
            clearInterval(memoryInterval);
            stats.endTime = Date.now();
            return;
        }

        // Send request
        makeRequest();
        requestsSent++;

        // Progress update
        if (requestsSent % (rps * 10) === 0) {
            const progress = Math.round((elapsed / (duration + warmup)) * 100);
            console.log(`Progress: ${progress}% | Requests: ${stats.requests} | In-flight: ${stats.inFlight}`);
        }
    }, interval);

    // Wait for completion
    await new Promise(resolve => {
        const checkComplete = setInterval(() => {
            if (stats.endTime && stats.inFlight === 0) {
                clearInterval(checkComplete);
                resolve();
            }
        }, 100);
    });

    console.log(`\nLoad test complete.\n`);
}

// Validate results against baselines
function validateResults() {
    const { thresholds } = profileConfig;
    const results = {
        passed: true,
        checks: [],
        summary: {}
    };

    const actualDuration = (stats.endTime - stats.startTime) / 1000;
    const throughput = stats.requests / actualDuration;
    const errorRate = stats.requests > 0 ? (stats.errors.total / stats.requests) * 100 : 0;
    const p50 = percentile(stats.latencies, 50);
    const p95 = percentile(stats.latencies, 95);
    const p99 = percentile(stats.latencies, 99);
    const avgLatency = stats.latencies.length > 0
        ? stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length
        : 0;

    // Memory analysis
    const memSnapshots = stats.memorySnapshots;
    const maxHeapMB = Math.max(...memSnapshots.map(s => s.heapUsed)) / 1024 / 1024;
    let memoryLeakRate = 0;
    if (memSnapshots.length >= 2) {
        const first = memSnapshots[0];
        const last = memSnapshots[memSnapshots.length - 1];
        const durationMinutes = (last.timestamp - first.timestamp) / 60000;
        if (durationMinutes > 0) {
            memoryLeakRate = ((last.heapUsed - first.heapUsed) / 1024 / 1024) / durationMinutes;
        }
    }

    results.summary = {
        totalRequests: stats.requests,
        successfulRequests: stats.successes,
        failedRequests: stats.errors.total,
        errorRate: Math.round(errorRate * 100) / 100,
        throughput: Math.round(throughput * 100) / 100,
        latency: { p50, p95, p99, avg: Math.round(avgLatency) },
        memory: {
            maxHeapMB: Math.round(maxHeapMB),
            leakRateMBPerMin: Math.round(memoryLeakRate * 100) / 100
        },
        errors: stats.errors
    };

    // Latency checks
    if (thresholds.latency) {
        if (thresholds.latency.p50) {
            const check = { name: 'Latency P50', expected: `<${thresholds.latency.p50}ms`, actual: `${p50}ms` };
            check.passed = p50 <= thresholds.latency.p50;
            results.checks.push(check);
            if (!check.passed) results.passed = false;
        }
        if (thresholds.latency.p95) {
            const check = { name: 'Latency P95', expected: `<${thresholds.latency.p95}ms`, actual: `${p95}ms` };
            check.passed = p95 <= thresholds.latency.p95;
            results.checks.push(check);
            if (!check.passed) results.passed = false;
        }
        if (thresholds.latency.p99) {
            const check = { name: 'Latency P99', expected: `<${thresholds.latency.p99}ms`, actual: `${p99}ms` };
            check.passed = p99 <= thresholds.latency.p99;
            results.checks.push(check);
            if (!check.passed) results.passed = false;
        }
    }

    // Throughput check
    if (thresholds.throughput && thresholds.throughput.min) {
        const check = {
            name: 'Throughput',
            expected: `>${thresholds.throughput.min} RPS`,
            actual: `${results.summary.throughput} RPS`
        };
        check.passed = throughput >= thresholds.throughput.min;
        results.checks.push(check);
        if (!check.passed) results.passed = false;
    }

    // Error rate check
    if (thresholds.errors && thresholds.errors.maxRate) {
        const check = {
            name: 'Error Rate',
            expected: `<${thresholds.errors.maxRate}%`,
            actual: `${results.summary.errorRate}%`
        };
        check.passed = errorRate <= thresholds.errors.maxRate;
        results.checks.push(check);
        if (!check.passed) results.passed = false;
    }

    // Memory checks
    if (thresholds.memory) {
        if (thresholds.memory.maxHeapMB) {
            const check = {
                name: 'Max Heap Memory',
                expected: `<${thresholds.memory.maxHeapMB}MB`,
                actual: `${results.summary.memory.maxHeapMB}MB`
            };
            check.passed = maxHeapMB <= thresholds.memory.maxHeapMB;
            results.checks.push(check);
            if (!check.passed) results.passed = false;
        }
        if (thresholds.memory.maxLeakMBPerMinute && actualDuration >= 60) {
            const check = {
                name: 'Memory Leak Rate',
                expected: `<${thresholds.memory.maxLeakMBPerMinute}MB/min`,
                actual: `${results.summary.memory.leakRateMBPerMin}MB/min`
            };
            check.passed = memoryLeakRate <= thresholds.memory.maxLeakMBPerMinute;
            results.checks.push(check);
            if (!check.passed) results.passed = false;
        }
    }

    return results;
}

// Print results
function printResults(results) {
    console.log(`========================================`);
    console.log(`Results Summary`);
    console.log(`========================================`);
    console.log(`Total Requests: ${results.summary.totalRequests}`);
    console.log(`Successful: ${results.summary.successfulRequests}`);
    console.log(`Failed: ${results.summary.failedRequests}`);
    console.log(`Error Rate: ${results.summary.errorRate}%`);
    console.log(`Throughput: ${results.summary.throughput} RPS`);
    console.log(`Latency P50: ${results.summary.latency.p50}ms`);
    console.log(`Latency P95: ${results.summary.latency.p95}ms`);
    console.log(`Latency P99: ${results.summary.latency.p99}ms`);
    console.log(`Max Heap: ${results.summary.memory.maxHeapMB}MB`);
    console.log(`----------------------------------------\n`);

    console.log(`Baseline Checks:`);
    results.checks.forEach(check => {
        const status = check.passed ? '✓ PASS' : '✗ FAIL';
        console.log(`  ${status}: ${check.name} (expected: ${check.expected}, actual: ${check.actual})`);
    });

    console.log(`\n========================================`);
    if (results.passed) {
        console.log(`✓ ALL BASELINE CHECKS PASSED`);
    } else {
        console.log(`✗ BASELINE VALIDATION FAILED`);
    }
    console.log(`========================================\n`);
}

// Main
async function main() {
    try {
        await runLoadTest();
        const results = validateResults();
        printResults(results);

        // Save output if requested
        if (options.output) {
            const output = {
                profile,
                config: profileConfig,
                results,
                timestamp: new Date().toISOString()
            };
            fs.writeFileSync(options.output, JSON.stringify(output, null, 2));
            console.log(`Results saved to: ${options.output}`);
        }

        process.exit(results.passed ? 0 : 1);
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

main();
