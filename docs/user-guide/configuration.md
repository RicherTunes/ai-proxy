# Configuration

Complete reference for GLM Proxy configuration options.

For a quick start guide, see [Getting Started](./getting-started.md).

## Environment Variables

> **Note:** For a quick reference of common environment variables, see the root [README.md](../../README.md#configuration).

| Variable | Default | Description |
|----------|---------|-------------|
| `GLM_PORT` | `18765` | Proxy listen port |
| `GLM_HOST` | `127.0.0.1` | Proxy listen address |
| `GLM_TARGET_HOST` | `api.z.ai` | Target API host |
| `GLM_MAX_WORKERS` | `4` | Maximum cluster workers |
| `GLM_NO_CLUSTER` | `0` | Set to `1` to disable clustering |
| `GLM_MAX_RETRIES` | `3` | Maximum retry attempts |
| `GLM_CIRCUIT_THRESHOLD` | `5` | Failures before circuit opens |
| `GLM_CIRCUIT_WINDOW` | `30000` | Failure window (ms) |
| `GLM_CIRCUIT_COOLDOWN` | `60000` | Circuit cooldown period (ms) |
| `GLM_MAX_CONCURRENCY_PER_KEY` | `3` | Max concurrent requests per key |
| `GLM_MAX_TOTAL_CONCURRENCY` | `200` | Max total concurrent requests |
| `GLM_QUEUE_SIZE` | `100` | Max requests to queue when keys busy |
| `GLM_QUEUE_TIMEOUT` | `30000` | Max queue wait time (ms) |
| `GLM_RATE_LIMIT` | `60` | Requests per minute per key (0=disabled) |
| `GLM_REQUEST_TIMEOUT` | `300000` | Request timeout (ms) |
| `GLM_LOG_LEVEL` | `INFO` | Log level (DEBUG, INFO, WARN, ERROR) |

### Additional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GLM_USE_WEIGHTED_SELECTION` | `true` | Health-weighted key selection |
| `GLM_SLOW_KEY_THRESHOLD` | `2.0` | Latency multiplier for slow key detection |
| `GLM_MAX_CONSECUTIVE_HANGUPS` | `5` | Max consecutive hangups before recreation |
| `GLM_POOL_COOLDOWN_MAX` | `30000` | Max pool cooldown (ms) |
| `GLM_HISTOGRAM_ENABLED` | `true` | Enable latency histogram |
| `GLM_COST_ENABLED` | `true` | Enable cost tracking |
| `GLM_TRACE_ENABLED` | `true` | Enable request tracing |
| `GLM_ADMIN_AUTH_ENABLED` | `true` | Enable admin authentication |
| `GLM_MAX_429_ATTEMPTS` | `3` | Max 429 retry attempts per request |
| `GLM_ALLOW_TIER_DOWNGRADE` | `true` | Allow tier downgrade on 429 |

## api-keys.json Format

The `api-keys.json` file contains your API credentials:

```json
{
  "keys": [
    "key-id-1.secret-1",
    "key-id-2.secret-2"
  ],
  "baseUrl": "https://api.z.ai/api/anthropic"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `keys` | array | Yes | List of API keys (format: `key-id.secret`) |
| `baseUrl` | string | No | Target API base URL |

## Circuit Breaker

> **Note:** For circuit breaker architecture diagrams, see [Architecture](../developer-guide/architecture.md#circuit-breaker).

The circuit breaker protects against failing API keys:

| State | Description |
|-------|-------------|
| `CLOSED` | Normal operation, requests flow through |
| `OPEN` | Key disabled after failures, requests skip this key |
| `HALF_OPEN` | Testing recovery with single request |

### Transitions

- `CLOSED → OPEN`: After `GLM_CIRCUIT_THRESHOLD` failures within `GLM_CIRCUIT_WINDOW` ms
- `OPEN → HALF_OPEN`: After `GLM_CIRCUIT_COOLDOWN` ms
- `HALF_OPEN → CLOSED`: Test request succeeds
- `HALF_OPEN → OPEN`: Test request fails

## Rate Limiting

Per-key rate limiting uses a token bucket algorithm:

- **Rate:** `GLM_RATE_LIMIT` requests per minute (0 = disabled)
- **Burst:** Allows short bursts above the rate limit

## Request Queue

When all API keys are at their concurrency limit, requests are queued:

| Setting | Default | Description |
|---------|---------|-------------|
| `GLM_QUEUE_SIZE` | `100` | Maximum requests to queue |
| `GLM_QUEUE_TIMEOUT` | `30000` | Maximum wait time (ms) |

When queue is full or timeout expires, clients receive:
- **Status:** 503 Service Unavailable
- **Header:** `Retry-After: N` (suggested retry delay in seconds)

## Running in Production

> **Note:** For production deployment details, see the root [README.md](../../README.md#running-in-production).

### Single Process Mode

```bash
NO_CLUSTER=1 npm start
```

### With PM2

```bash
pm2 start proxy.js --name glm-proxy
```

### With systemd

```ini
[Unit]
Description=GLM Proxy
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/glm-proxy
ExecStart=/usr/bin/node proxy.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Hot Reload

Reload API keys without restart:

```bash
curl -X POST http://127.0.0.1:18765/reload
```
