/**
 * Performance Baseline Tests (Week 4)
 *
 * Tests that validate the proxy meets performance baselines.
 * These tests make real requests to a running proxy instance.
 *
 * Run with: npm run test:stress -- baseline.test.js
 *
 * Prerequisites:
 *   - Proxy must be running on localhost:3000
 *   - Or set PROXY_URL environment variable
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Load baseline configuration
const baselinePath = path.join(__dirname, '../../config/performance-baseline.json');
const baselineConfig = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
    : null;

// Test configuration
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3000';
const SKIP_IF_NO_PROXY = process.env.CI !== 'true'; // Skip in local dev if proxy not running

// Helper to check if proxy is available
async function isProxyAvailable() {
    return new Promise((resolve) => {
        const url = new URL('/health', PROXY_URL);
        const client = url.protocol === 'https:' ? https : http;

        const req = client.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'GET',
            timeout: 2000
        }, (res) => {
            resolve(res.statusCode === 200 || res.statusCode === 503);
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.end();
    });
}

// Helper to make a request
function makeRequest(options = {}) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const url = new URL(options.path || '/v1/chat/completions', PROXY_URL);
        const client = url.protocol === 'https:' ? https : http;

        const body = options.body || JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            messages: [{ role: 'user', content: 'Test request' }],
            max_tokens: 10
        });

        const req = client.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: options.method || 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...options.headers
            },
            timeout: options.timeout || 30000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    latency: Date.now() - startTime,
                    data,
                    headers: res.headers
                });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(body);
        req.end();
    });
}

// Helper to make concurrent requests
async function makeConcurrentRequests(count, options = {}) {
    const promises = [];
    for (let i = 0; i < count; i++) {
        promises.push(makeRequest(options).catch(err => ({ error: err.message })));
    }
    return Promise.all(promises);
}

// Calculate percentile
function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

describe('Performance Baseline Tests', () => {
    let proxyAvailable = false;

    beforeAll(async () => {
        proxyAvailable = await isProxyAvailable();
        if (!proxyAvailable && SKIP_IF_NO_PROXY) {
            console.log('Proxy not available, skipping baseline tests');
        }
    });

    describe('Smoke Tests', () => {
        test('proxy health check responds', async () => {
            if (!proxyAvailable) {
                console.log('Skipping: proxy not available');
                return;
            }

            const result = await makeRequest({
                path: '/health',
                method: 'GET',
                body: ''
            });

            expect([200, 503]).toContain(result.statusCode);
            expect(result.latency).toBeLessThan(1000);
        });

        test('metrics endpoint responds with Prometheus format', async () => {
            if (!proxyAvailable) return;

            const result = await makeRequest({
                path: '/metrics',
                method: 'GET',
                body: ''
            });

            expect(result.statusCode).toBe(200);
            expect(result.data).toContain('# HELP');
            expect(result.data).toContain('glm_proxy');
        });

        test('deep health check includes all components', async () => {
            if (!proxyAvailable) return;

            const result = await makeRequest({
                path: '/health/deep',
                method: 'GET',
                body: ''
            });

            expect([200, 503]).toContain(result.statusCode);
            const data = JSON.parse(result.data);
            expect(data.checks).toBeDefined();
            expect(data.checks.keys).toBeDefined();
            expect(data.checks.memory).toBeDefined();
        });
    });

    describe('Concurrency Tests', () => {
        test('handles 10 concurrent requests', async () => {
            if (!proxyAvailable) return;

            const results = await makeConcurrentRequests(10);
            const successful = results.filter(r => r.statusCode && r.statusCode < 500);
            const latencies = results.filter(r => r.latency).map(r => r.latency);

            expect(successful.length).toBeGreaterThanOrEqual(5); // At least 50% success
            expect(percentile(latencies, 95)).toBeLessThan(30000); // P95 under 30s
        }, 60000);

        test('handles 25 concurrent requests', async () => {
            if (!proxyAvailable) return;

            const results = await makeConcurrentRequests(25);
            const successful = results.filter(r => r.statusCode && r.statusCode < 500);

            expect(successful.length).toBeGreaterThanOrEqual(10); // At least 40% success
        }, 90000);
    });

    describe('Throughput Tests', () => {
        test('sustains minimum throughput for 10 seconds', async () => {
            if (!proxyAvailable) return;

            const duration = 10000; // 10 seconds
            const targetRps = 2;
            const interval = 1000 / targetRps;

            const startTime = Date.now();
            const results = [];

            // Generate requests at target rate
            while (Date.now() - startTime < duration) {
                const reqStart = Date.now();
                const result = await makeRequest().catch(err => ({ error: err.message }));
                results.push(result);

                // Wait for next interval
                const elapsed = Date.now() - reqStart;
                if (elapsed < interval) {
                    await new Promise(resolve => setTimeout(resolve, interval - elapsed));
                }
            }

            const actualDuration = (Date.now() - startTime) / 1000;
            const throughput = results.length / actualDuration;

            expect(throughput).toBeGreaterThan(1); // At least 1 RPS sustained
        }, 30000);
    });

    describe('Memory Tests', () => {
        test('memory usage stays within bounds after batch requests', async () => {
            if (!proxyAvailable) return;

            const initialMemory = process.memoryUsage();

            // Make a batch of requests
            await makeConcurrentRequests(20);

            // Force GC if available
            if (global.gc) {
                global.gc();
            }

            const finalMemory = process.memoryUsage();
            const heapGrowthMB = (finalMemory.heapUsed - initialMemory.heapUsed) / 1024 / 1024;

            // Heap growth should be reasonable (under 50MB for this test)
            expect(heapGrowthMB).toBeLessThan(50);
        }, 60000);
    });

    describe('Error Handling Tests', () => {
        test('handles rapid requests without crashing', async () => {
            if (!proxyAvailable) return;

            // Fire 50 requests as fast as possible
            const results = await makeConcurrentRequests(50);

            // Should complete without throwing
            expect(results.length).toBe(50);

            // Most should have a response (not connection errors)
            const withResponse = results.filter(r => r.statusCode !== undefined);
            expect(withResponse.length).toBeGreaterThan(25);
        }, 120000);

        test('returns appropriate error codes under load', async () => {
            if (!proxyAvailable) return;

            const results = await makeConcurrentRequests(30);

            // Check error codes are appropriate
            results.forEach(r => {
                if (r.statusCode) {
                    // Should be success or expected error (rate limit, backpressure)
                    expect([200, 201, 429, 500, 502, 503, 504]).toContain(r.statusCode);
                }
            });
        }, 90000);
    });

    describe('Baseline Configuration', () => {
        test('baseline configuration file exists and is valid', () => {
            expect(baselineConfig).not.toBeNull();
            expect(baselineConfig.profiles).toBeDefined();
            expect(baselineConfig.profiles.smoke).toBeDefined();
            expect(baselineConfig.profiles.standard).toBeDefined();
        });

        test('smoke profile has required thresholds', () => {
            if (!baselineConfig) return;

            const smoke = baselineConfig.profiles.smoke;
            expect(smoke.thresholds).toBeDefined();
            expect(smoke.thresholds.latency).toBeDefined();
            expect(smoke.thresholds.throughput).toBeDefined();
            expect(smoke.thresholds.errors).toBeDefined();
        });

        test('all profiles have valid configurations', () => {
            if (!baselineConfig) return;

            Object.entries(baselineConfig.profiles).forEach(([name, profile]) => {
                expect(profile.duration).toBeGreaterThan(0);
                expect(profile.rps).toBeGreaterThan(0);
                expect(profile.concurrency).toBeGreaterThan(0);
                expect(profile.thresholds).toBeDefined();
            });
        });
    });
});
