---
layout: default
title: Configuration
---

# Configuration

Complete reference for AI Proxy configuration options.

> **Related:**
> - [Getting Started](./getting-started.md) - Basic setup guide
> - [Monitoring](./monitoring.md) - Health checks and stats endpoints
> - [Security Configuration](../operations/security.md) - Admin authentication and secure deployment
> - [Z.ai Knowledge Base](../reference/zai-knowledge-base.md) - Provider-specific configuration

> **New to configuration?** Start with the [Getting Started](./getting-started.md) guide for basic setup. You only need to read this if you want to customize advanced settings.

## What Are Environment Variables?

**Environment variables** are settings that control how the proxy behaves. Think of them like configuration knobs you can adjust without changing any code.

**How to set them:**

**Mac/Linux:**

```bash
export GLM_PORT=8080
npm start
```

**Windows PowerShell:**

```powershell
$env:GLM_PORT="8080"
npm start
```

**Windows Command Prompt:**

```cmd
set GLM_PORT=8080 && npm start
```

> **Quick Reference:** For the most commonly used environment variables, see the root [README.md](../../README.md#configuration).

## Environment Variables

| Variable | Default | Description | What This Means |
|----------|---------|-------------|-----------------|
| `GLM_PORT` | `18765` | Proxy listen port | Which "door" your app uses to connect. Default is fine for most users |
| `GLM_HOST` | `127.0.0.1` | Proxy listen address | Which network address to listen on. `127.0.0.1` = only your computer can connect |
| `GLM_TARGET_HOST` | `api.z.ai` | Target API host | The upstream API service you're connecting to |
| `GLM_MAX_WORKERS` | `4` | Maximum cluster workers | How many worker processes to run. More workers = handles more requests, but uses more memory |
| `GLM_NO_CLUSTER` | `0` | Set to `1` to disable clustering | Set to `1` if you want to run a single process instead of multiple workers |
| `GLM_MAX_RETRIES` | `3` | Maximum retry attempts | How many times to retry a failed request before giving up |
| `GLM_CIRCUIT_THRESHOLD` | `5` | Failures before circuit opens | After how many failures a key is temporarily disabled (see "Circuit Breaker" below) |
| `GLM_CIRCUIT_WINDOW` | `30000` | Failure window (ms) | Time period (in milliseconds) in which failures are counted |
| `GLM_CIRCUIT_COOLDOWN` | `60000` | Circuit cooldown period (ms) | How long (in milliseconds) to wait before trying a failed key again |
| `GLM_MAX_CONCURRENCY_PER_KEY` | `5` | Max concurrent requests per key | Maximum number of simultaneous requests per API key |
| `GLM_MAX_TOTAL_CONCURRENCY` | `200` | Max total concurrent requests | Maximum number of simultaneous requests across all keys |
| `GLM_QUEUE_SIZE` | `100` | Max requests to queue when keys busy | How many requests to wait in line when all keys are busy |
| `GLM_QUEUE_TIMEOUT` | `30000` | Max queue wait time (ms) | How long (in milliseconds) a request will wait before giving up |
| `GLM_RATE_LIMIT` | `60` | Requests per minute per key (0=disabled) | Maximum requests per minute for each key. Set to `0` to disable |
| `GLM_REQUEST_TIMEOUT` | `300000` | Request timeout (ms) | How long (in milliseconds) to wait for a request to complete |
| `GLM_LOG_LEVEL` | `INFO` | Log level | How much detail to show in logs: `DEBUG` (most), `INFO`, `WARN`, `ERROR` (least) |
| `GLM_ADAPTIVE_CONCURRENCY_MODE` | `observe_only` | Adaptive concurrency mode | `observe_only` (compute windows but don't enforce) or `enforce` (apply computed limits). Invalid values are coerced to `observe_only` |

### Additional Environment Variables

> **Security Settings:** See [Security Configuration](../operations/security.md) for admin authentication and security modes.

See the [README.md](../../README.md#additional-environment-variables) for the full list of additional environment variables including weighted selection, cost tracking, admin auth, and tier downgrade settings.

## Understanding Key Concepts

Before configuring advanced settings, it helps to understand these concepts:

> **What is "Concurrency"?**
>
> Concurrency means "how many things happening at the same time." If you set `GLM_MAX_CONCURRENCY_PER_KEY=5`, it means the proxy will send at most 5 simultaneous requests to each API key. Any additional requests will wait in a queue.

> **What is a "Rate Limit"?**
>
> A rate limit is like a speed limit for API requests. It says "you can only make X requests per minute." If you go faster, the API will say "slow down!" (HTTP 429 error). The proxy helps you stay under this limit by spreading requests across multiple keys.

> **What is a "Circuit Breaker"?**
>
> Imagine a safety switch in your house that turns off power when there's an electrical problem. A circuit breaker does the same thing for API keys: if a key keeps failing, the proxy stops using it temporarily to prevent more errors. See the "Circuit Breaker" section below for details.

> **What is "Upstream" vs "Downstream"?**
>
> - **Upstream:** The API service you're connecting to (like Z.AI or Anthropic)
> - **Downstream:** Your application that's making requests
> - **Proxy:** Sits in the middle, managing the connection between them

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

> **Need API keys?** Sign up at [z.ai](https://z.ai) and create API keys in your dashboard. See [Z.ai Documentation](../reference/zai-coding-subscription.md) for tier comparisons and pricing.

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `keys` | array | Yes | List of API keys (format: `key-id.secret`) |
| `baseUrl` | string | No | Target API base URL |

> **Note:** Z.ai uses the format `sk-sp-xxxxx` for Coding Plan subscriptions. See [Z.ai Knowledge Base](../reference/zai-knowledge-base.md#api-reference) for endpoint details.

## Circuit Breaker

> **Note:** For circuit breaker architecture diagrams, see [Architecture](../developer-guide/architecture.md#circuit-breaker).

### What is a Circuit Breaker?

A **circuit breaker** is a safety feature that protects against failing API keys.

**Think of it like this:** Imagine you have 5 light bulbs in parallel, and one keeps burning out. A circuit breaker detects which bulb is faulty and turns it off, while the other 4 keep working. When the faulty bulb is replaced, the circuit breaker turns it back on.

**In practice:**

- If an API key starts failing (returns errors), the proxy stops using it
- Other healthy keys continue working normally
- After a cooldown period, the proxy tries the failed key again
- If it works, the key is restored. If it still fails, it stays disabled

**You can see circuit breaker states in the dashboard's System page:**

![Circuit Breaker Indicators](../screenshots/components/circuit-indicators.png)

### States

| State | What It Means | What Happens |
|-------|---------------|--------------|
| `CLOSED` | Everything is working normally | Requests flow through this key |
| `OPEN` | Key has failed multiple times | Key is disabled, requests skip it and use other keys |
| `HALF_OPEN` | Testing if the key recovered | Proxy sends one test request to check if it's working again |

### Transitions

- `CLOSED → OPEN`: After `GLM_CIRCUIT_THRESHOLD` failures within `GLM_CIRCUIT_WINDOW` ms
- `OPEN → HALF_OPEN`: After `GLM_CIRCUIT_COOLDOWN` ms (waiting period)
- `HALF_OPEN → CLOSED`: Test request succeeds → key is restored
- `HALF_OPEN → OPEN`: Test request fails → key stays disabled

## Rate Limiting

### What is Rate Limiting?

**Rate limiting** controls how many requests you can make in a time period (usually per minute). Think of it like a speed limit on a highway — if you go too fast, you'll get pulled over (receive a 429 error).

### How the Proxy Handles Rate Limits

The proxy uses a **token bucket algorithm** to manage rate limits. Here's what that means in simple terms:

- **Rate:** `GLM_RATE_LIMIT` requests per minute (set to `0` to disable)
- **Burst:** Allows short bursts above the rate limit temporarily

**Think of it like this:** You have a bucket that fills up with "tokens" over time. Each request uses one token. If the bucket is empty, you have to wait for more tokens. But the bucket can hold some extra tokens, allowing short bursts of activity.

## Request Queue

### What is the Request Queue?

When all API keys are busy handling their maximum number of concurrent requests, new requests don't fail immediately — they wait in a **queue** (a waiting line).

**Think of it like a line at a store:** If all cashiers are busy, customers wait in line. When a cashier becomes free, the next person in line gets served.

| Setting | Default | What It Does |
|---------|---------|--------------|
| `GLM_QUEUE_SIZE` | `100` | Maximum number of requests that can wait in line |
| `GLM_QUEUE_TIMEOUT` | `30000` | Maximum time (in milliseconds) a request will wait before giving up |

**What happens when the queue is full or timeout expires?**

The client receives:

- **Status:** 503 Service Unavailable
- **Header:** `Retry-After: N` (tells the client how many seconds to wait before trying again)

## Running in Production

> **Note:** For production deployment details, see the root [README.md](../../README.md#running-in-production).

### Single Process Mode

```bash
# Mac/Linux
NO_CLUSTER=1 npm start
```

```powershell
# Windows PowerShell
$env:NO_CLUSTER="1"; npm start
```

```cmd
# Windows Command Prompt
set NO_CLUSTER=1 && npm start
```

### With PM2

```bash
# Mac/Linux
pm2 start proxy.js --name glm-proxy
```

```powershell
# Windows PowerShell
pm2 start proxy.js --name glm-proxy
```

### With systemd

```ini
[Unit]
Description=AI Proxy
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
# Mac/Linux
curl -X POST http://127.0.0.1:18765/reload
```

```powershell
# Windows PowerShell
Invoke-WebRequest -Uri http://127.0.0.1:18765/reload -Method POST
```

## See Also

- **[Getting Started](./getting-started.md)** — Step-by-step setup guide
- **[Monitoring](./monitoring.md)** — Health checks and statistics endpoints
- **[Architecture - Circuit Breaker](../developer-guide/architecture.md#circuit-breaker)** — Circuit breaker design and diagrams
- **[README.md](../../README.md)** — Project overview and quick start
- **[TROUBLESHOOTING.md](../../TROUBLESHOOTING.md)** — Common issues and solutions
