# Load Testing Guide

This document describes how to run load tests and validate performance baselines for the GLM Proxy.

## Dashboard Monitoring During Load Tests

The dashboard provides real-time visibility into system performance during load tests. Key sections to monitor:

![Dashboard Overview](../screenshots/overview.png)

**Error Breakdown** - View error types during load tests:

![Error Breakdown](../screenshots/system/error-breakdown.png)

**Retry Analytics** - Monitor retry behavior under load:

![Retry Analytics](../screenshots/system/retry-analytics.png)

**Health Score** - Track overall system health:

![Health Score](../screenshots/system/health-score.png)

## Quick Start

```bash
# Run a quick smoke test (30s, 5 RPS)
npm run baseline:smoke

# Run a standard load test (2min, 20 RPS)
npm run baseline:standard

# Run a stress test (5min, 50 RPS)
npm run baseline:stress
```

## Performance Baselines

Baselines are defined in `config/performance-baseline.json`. Each profile specifies:

- **Duration**: How long to run the test
- **RPS**: Target requests per second
- **Concurrency**: Maximum concurrent requests
- **Warmup**: Seconds to warm up before measuring
- **Thresholds**: Pass/fail criteria

### Available Profiles

| Profile | Duration | RPS | Use Case |
|---------|----------|-----|----------|
| smoke | 30s | 5 | Quick CI validation |
| standard | 120s | 20 | Regression detection |
| stress | 300s | 50 | Capacity planning |
| soak | 1hr | 10 | Memory leak detection |

### Threshold Categories

1. **Latency** (milliseconds)
   - P50: Median response time
   - P95: 95th percentile
   - P99: 99th percentile

2. **Throughput**
   - Minimum requests per second

3. **Errors**
   - Maximum error rate (percentage)

4. **Memory**
   - Maximum heap usage (MB)
   - Maximum leak rate (MB/minute)

## Running Tests

### Prerequisites

1. Start the proxy server:
   ```bash
   npm start
   ```

2. Ensure you have API keys configured in your `.env` or `keys.txt`

### Basic Load Test

```bash
# Custom load test with the load.js script
node scripts/load.js --rps=10 --duration=60 --verbose
```

### Baseline Validation

```bash
# Validate against smoke baseline (exits with code 1 if failed)
npm run baseline:smoke

# Save results to file
node scripts/validate-baseline.js smoke --output=results.json

# Run against custom target
node scripts/validate-baseline.js standard --target=http://proxy.example.com:3000
```

### Stress Tests with Jest

```bash
# Run all stress tests
npm run test:stress

# Run specific baseline tests
npm run test:stress -- baseline.test.js
```

## Interpreting Results

### Success Output

```
========================================
Results Summary
========================================
Total Requests: 150
Successful: 145
Failed: 5
Error Rate: 3.33%
Throughput: 5.12 RPS
Latency P50: 1234ms
Latency P95: 3456ms
Latency P99: 5678ms
Max Heap: 256MB
----------------------------------------

Baseline Checks:
  ✓ PASS: Latency P50 (expected: <5000ms, actual: 1234ms)
  ✓ PASS: Latency P95 (expected: <15000ms, actual: 3456ms)
  ✓ PASS: Throughput (expected: >3 RPS, actual: 5.12 RPS)
  ✓ PASS: Error Rate (expected: <10%, actual: 3.33%)

========================================
✓ ALL BASELINE CHECKS PASSED
========================================
```

### Failure Output

```
Baseline Checks:
  ✓ PASS: Latency P50 (expected: <5000ms, actual: 1234ms)
  ✗ FAIL: Latency P95 (expected: <15000ms, actual: 18000ms)
  ✗ FAIL: Throughput (expected: >3 RPS, actual: 2.1 RPS)
  ✓ PASS: Error Rate (expected: <10%, actual: 3.33%)

========================================
✗ BASELINE VALIDATION FAILED
========================================
```

## CI Integration

Add baseline validation to your CI pipeline:

```yaml
# Example GitHub Actions
test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: npm install
    - run: npm start &
    - run: sleep 5  # Wait for server to start
    - run: npm run baseline:ci
```

## Updating Baselines

When performance improves, update the baseline thresholds:

1. Run a standard baseline test to get current metrics
2. Update `config/performance-baseline.json` with new thresholds
3. Add a buffer (e.g., 20%) above current metrics for variability
4. Document the change with date and reason

Example update:
```json
{
  "latency": {
    "p50": 3000,  // Was 5000, improved due to connection pooling
    "p95": 10000,
    "p99": 20000
  }
}
```

## Troubleshooting

### High Latency

1. Check if upstream API is slow
2. Verify connection pooling is working
3. Look for circuit breaker trips
4. Check for rate limiting

### High Error Rate

1. Check API key validity
2. Look for rate limit errors (429)
3. Verify upstream availability
4. Check backpressure queue

### Memory Growth

1. Run soak test to confirm leak
2. Check for event listener leaks
3. Verify request cleanup
4. Profile with `--inspect`

## Advanced Usage

### Custom Profiles

Add custom profiles to `config/performance-baseline.json`:

```json
{
  "profiles": {
    "my-custom": {
      "description": "Custom test for specific use case",
      "duration": 60,
      "rps": 15,
      "concurrency": 15,
      "warmup": 10,
      "thresholds": {
        "latency": { "p95": 8000 },
        "errors": { "maxRate": 5 }
      }
    }
  }
}
```

### Programmatic Access

```javascript
const { makeRequest, percentile } = require('./scripts/load');

async function customTest() {
  const results = [];
  for (let i = 0; i < 100; i++) {
    results.push(await makeRequest());
  }
  console.log('P95:', percentile(results.map(r => r.latency), 95));
}
```

## Metrics Reference

| Metric | Description | Source |
|--------|-------------|--------|
| requests.total | Total requests sent | Load script |
| requests.success | Successful responses (2xx) | Load script |
| latency.p50 | Median response time | Calculated |
| latency.p95 | 95th percentile latency | Calculated |
| throughput.rps | Requests per second | Calculated |
| errors.rate | Error percentage | Calculated |
| memory.heapUsed | V8 heap memory | process.memoryUsage() |
| memory.rss | Resident set size | process.memoryUsage() |
