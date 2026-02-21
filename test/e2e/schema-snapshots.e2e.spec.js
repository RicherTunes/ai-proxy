/**
 * Schema Snapshot Tests
 *
 * Validates API endpoint schemas don't regress.
 * These tests assert on the STRUCTURE (keys present, types correct)
 * not the VALUES (which change per request).
 *
 * Schema Version: 1.0.0
 * Last Updated: 2026-01-28
 */

const { test, expect, getSSEEvent } = require('./fixtures');
const http = require('http');

// Schema version - bump when intentionally changing API shape
const SCHEMA_VERSION = '1.0.0';

// Helper to make HTTP request
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body,
        json: () => { try { return JSON.parse(body); } catch { return null; } }
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// Type assertion helpers
function assertType(value, expectedType, path) {
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (actualType !== expectedType) {
    throw new Error(`Schema violation at ${path}: expected ${expectedType}, got ${actualType}`);
  }
}

function assertOptionalType(value, expectedType, path) {
  if (value === undefined || value === null) return;
  assertType(value, expectedType, path);
}

function assertOneOf(value, allowedValues, path) {
  if (!allowedValues.includes(value)) {
    throw new Error(`Schema violation at ${path}: expected one of [${allowedValues.join(', ')}], got ${value}`);
  }
}

test.describe('Schema Snapshots - /stats Endpoint', () => {
  test('/stats schema v1.0.0 - top level structure', async ({ proxyServer }) => {
    const response = await makeRequest(proxyServer.url + '/stats');
    expect(response.statusCode).toBe(200);

    const stats = response.json();
    expect(stats).toBeTruthy();

    // Required top-level fields
    const requiredFields = [
      'uptime',
      'uptimeFormatted',
      'totalRequests',
      'successRate',
      'latency',
      'keys',
      'errors',
      'tokens',
      'rateLimitTracking'
    ];

    for (const field of requiredFields) {
      expect(stats).toHaveProperty(field);
    }

    // Type assertions
    assertType(stats.uptime, 'number', 'uptime');
    assertType(stats.uptimeFormatted, 'string', 'uptimeFormatted');
    assertType(stats.totalRequests, 'number', 'totalRequests');
    assertOptionalType(stats.successRate, 'number', 'successRate');
    assertType(stats.latency, 'object', 'latency');
    assertType(stats.keys, 'array', 'keys');
    assertType(stats.errors, 'object', 'errors');
    assertType(stats.tokens, 'object', 'tokens');
    assertType(stats.rateLimitTracking, 'object', 'rateLimitTracking');
  });

  test('/stats schema v1.0.0 - latency structure', async ({ proxyServer }) => {
    const response = await makeRequest(proxyServer.url + '/stats');
    const stats = response.json();

    const latency = stats.latency;
    const latencyFields = ['avg', 'min', 'max', 'p50', 'p95', 'p99', 'samples'];

    for (const field of latencyFields) {
      expect(latency).toHaveProperty(field);
    }

    // All latency values are number or null
    for (const field of ['avg', 'min', 'max', 'p50', 'p95', 'p99']) {
      if (latency[field] !== null) {
        assertType(latency[field], 'number', `latency.${field}`);
      }
    }
    assertType(latency.samples, 'number', 'latency.samples');
  });

  test('/stats schema v1.0.0 - keys array structure', async ({ proxyServer }) => {
    const response = await makeRequest(proxyServer.url + '/stats');
    const stats = response.json();

    expect(stats.keys.length).toBeGreaterThan(0);

    const key = stats.keys[0];
    const keyFields = ['index', 'state', 'inFlight', 'total', 'successes', 'failures'];

    for (const field of keyFields) {
      expect(key).toHaveProperty(field);
    }

    assertType(key.index, 'number', 'keys[0].index');
    assertType(key.state, 'string', 'keys[0].state');
    assertOneOf(key.state, ['CLOSED', 'OPEN', 'HALF_OPEN'], 'keys[0].state');
    assertType(key.inFlight, 'number', 'keys[0].inFlight');
    assertType(key.total, 'number', 'keys[0].total');
  });

  test('/stats schema v1.0.0 - errors structure', async ({ proxyServer }) => {
    const response = await makeRequest(proxyServer.url + '/stats');
    const stats = response.json();

    const errors = stats.errors;
    const errorFields = [
      'timeouts',
      'socketHangups',
      'connectionRefused',
      'serverErrors',
      'rateLimited'
    ];

    for (const field of errorFields) {
      expect(errors).toHaveProperty(field);
      assertType(errors[field], 'number', `errors.${field}`);
    }
  });

  test('/stats schema v1.0.0 - tokens structure', async ({ proxyServer }) => {
    const response = await makeRequest(proxyServer.url + '/stats');
    const stats = response.json();

    const tokens = stats.tokens;
    const tokenFields = ['totalInputTokens', 'totalOutputTokens', 'totalTokens', 'requestCount'];

    for (const field of tokenFields) {
      expect(tokens).toHaveProperty(field);
      assertType(tokens[field], 'number', `tokens.${field}`);
    }
  });

  test('/stats schema v1.0.0 - rateLimitTracking structure', async ({ proxyServer }) => {
    const response = await makeRequest(proxyServer.url + '/stats');
    const stats = response.json();

    const rlt = stats.rateLimitTracking;
    const rltFields = [
      'upstream429s',
      'local429s',
      'llm429Retries',
      'llm429RetrySuccesses',
      'poolCooldowns'
    ];

    for (const field of rltFields) {
      expect(rlt).toHaveProperty(field);
      assertType(rlt[field], 'number', `rateLimitTracking.${field}`);
    }
  });

  test('/stats schema v1.0.0 - poolCooldown structure', async ({ proxyServer }) => {
    const response = await makeRequest(proxyServer.url + '/stats');
    const stats = response.json();

    expect(stats).toHaveProperty('poolCooldown');
    const pc = stats.poolCooldown;

    // Updated schema: isRateLimited instead of inCooldown
    expect(pc).toHaveProperty('isRateLimited');
    assertType(pc.isRateLimited, 'boolean', 'poolCooldown.isRateLimited');

    expect(pc).toHaveProperty('cooldownRemainingMs');
    assertType(pc.cooldownRemainingMs, 'number', 'poolCooldown.cooldownRemainingMs');

    expect(pc).toHaveProperty('pool429Count');
    assertType(pc.pool429Count, 'number', 'poolCooldown.pool429Count');
  });
});

test.describe('Schema Snapshots - /health Endpoint', () => {
  test('/health schema v1.0.0', async ({ proxyServer }) => {
    const response = await makeRequest(proxyServer.url + '/health');
    expect(response.statusCode).toBe(200);

    const health = response.json();
    expect(health).toHaveProperty('status');
    assertType(health.status, 'string', 'status');
    // API returns uppercase "OK"
    expect(health.status.toLowerCase()).toBe('ok');
  });
});

test.describe('Schema Snapshots - SSE Events', () => {
  test('connected event schema v1.0.0', async ({ proxyServer }) => {
    // Use Node.js EventSource instead of browser to avoid CORS issues
    const eventData = await getSSEEvent(proxyServer.url + '/events', 'connected');

    // Required fields for connected event
    const requiredFields = ['type', 'seq', 'ts', 'schemaVersion', 'clientId', 'recentRequests'];

    for (const field of requiredFields) {
      expect(eventData).toHaveProperty(field);
    }

    expect(eventData.type).toBe('connected');
    expect(typeof eventData.seq).toBe('number');
    expect(typeof eventData.ts).toBe('number');
    expect(typeof eventData.schemaVersion).toBe('number');
    expect(eventData.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(typeof eventData.clientId).toBe('string');
    expect(Array.isArray(eventData.recentRequests)).toBe(true);
  });

  test('request event schema v1.0.0', async ({ proxyServer }) => {
    // Start listening for request event using Node.js EventSource
    const eventPromise = getSSEEvent(proxyServer.url + '/events', 'request', 8000);

    // Trigger a request
    const req = http.request(proxyServer.url + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key1.secret1' }
    });
    req.write(JSON.stringify({
      model: 'claude-3-sonnet-20240229',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test' }]
    }));
    req.end();

    const eventData = await eventPromise;

    if (eventData) {
      // Required fields for request event
      const requiredFields = ['seq', 'ts', 'requestId'];

      for (const field of requiredFields) {
        expect(eventData).toHaveProperty(field);
      }

      expect(typeof eventData.seq).toBe('number');
      expect(typeof eventData.ts).toBe('number');
      expect(typeof eventData.requestId).toBe('string');

      // Optional but expected fields
      if (eventData.status !== undefined) {
        expect(['number', 'string']).toContain(typeof eventData.status);
      }
      if (eventData.latencyMs !== undefined) {
        expect(typeof eventData.latencyMs).toBe('number');
      }
    }
  });

  test('kpi event schema v1.0.0', async ({ page, proxyServer }) => {
    // KPI events are periodic, may need to wait
    const eventData = await page.evaluate(async (baseUrl) => {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 10000);
        const es = new EventSource(baseUrl + '/events');
        es.addEventListener('kpi', (e) => {
          clearTimeout(timeout);
          es.close();
          resolve(JSON.parse(e.data));
        });
        es.onerror = () => {
          clearTimeout(timeout);
          es.close();
          resolve(null);
        };
      });
    }, proxyServer.url);

    if (eventData) {
      // KPI event should have performance metrics
      expect(typeof eventData.seq).toBe('number');
      expect(typeof eventData.ts).toBe('number');

      // Expected KPI fields (may vary by implementation)
      const possibleFields = ['rpm', 'successRate', 'p95', 'poolHealth', 'keysHealth'];
      const hasAtLeastOne = possibleFields.some(f => eventData.hasOwnProperty(f));
      expect(hasAtLeastOne).toBe(true);
    }
  });
});

test.describe('Schema Snapshots - Version Tracking', () => {
  test('schema version is documented', () => {
    // This test documents the current schema version
    expect(SCHEMA_VERSION).toBe('1.0.0');
    console.log(`Testing against schema version: ${SCHEMA_VERSION}`);
  });
});
