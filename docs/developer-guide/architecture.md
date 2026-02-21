# Architecture

System architecture overview for GLM Proxy.

## Overview

GLM Proxy is a Node.js-based HTTP proxy that provides intelligent request routing, load balancing, and fault tolerance for API requests to the Z.AI GLM service.

## System Components

```
┌────────────────────────────────────────────────────────────────────────┐
│                           GLM Proxy                                    │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ┌──────────────┐     ┌────────────────────────────────────────────┐  │
│  │   HTTP       │────>│  Request Handler                            │  │
│  │   Server     │     │  (retry, backoff, timeout, streaming)       │  │
│  └──────────────┘     └──────────┬─────────────────────────────────┘  │
│                                     │                                  │
│                                     v                                  │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │               Model Router (Complexity-Aware)                   │   │
│  │  - Light/Medium/Heavy tier classification                       │   │
│  │  - Per-key model overrides                                      │   │
│  │  - Cost tracking integration                                    │   │
│  └──────────────────────────┬─────────────────────────────────────┘   │
│                             │                                          │
│                             v                                          │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │            Key Manager & Key Scheduler                          │   │
│  │  - Health-weighted key selection (not just round-robin)        │   │
│  │  - Drift detection for fairness monitoring                      │   │
│  │  - Circuit state tracking                                       │   │
│  └──────────────────────────┬─────────────────────────────────────┘   │
│                             │                                          │
│                             v                                          │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │            Adaptive Concurrency (AIMD)                          │   │
│  │  - Per-model dynamic limits                                     │   │
│  │  - 429 feedback handling                                        │   │
│  │  - observe_only or enforce modes                                │   │
│  └──────────────────────────┬─────────────────────────────────────┘   │
│                             │                                          │
│                             v                                          │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │               Rate Limiter (Token Bucket)                       │   │
│  └──────────────────────────┬─────────────────────────────────────┘   │
│                             │                                          │
│                             v                                          │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │              Request Queue (Backpressure)                       │   │
│  └──────────────────────────┬─────────────────────────────────────┘   │
│                             │                                          │
└─────────────────────────────┼──────────────────────────────────────────┘
                              │
                              v
                ┌───────────────────────────┐
                │       Target API          │
                │       (api.z.ai)          │
                └───────────────────────────┘
```

## Core Modules

### Entry Point

- **`proxy.js`** - Main server entry point, initializes all components

### Configuration

- **`lib/config.js`** - Configuration management with environment variable overrides and normalization
- **`lib/pricing-loader.js`** - Loads model pricing from `config/pricing.json` with change detection

### Logging

- **`lib/logger.js`** - Structured JSON logging

### Key Management

- **`lib/key-manager.js`** - API key rotation, health scoring, and circuit breaker logic
- **`lib/key-scheduler.js`** - Intelligent key selection with health-weighted scoring and drift detection (1067 lines)
- **`lib/circuit-breaker.js`** - Per-key circuit breaker implementation

### Request Handling

- **`lib/request-handler.js`** - Proxy logic with retries, backoff, and streaming
- **`lib/proxy/router.js`** - Route registry and dispatch
- **`lib/proxy/controllers/`** - 15 controller files (health, auth, stats, etc.)

### Model Routing

- **`lib/model-router.js`** - Complexity-aware tiered model routing with overrides (3734 lines)
- **`lib/cost-tracker.js`** - Per-model cost tracking with external pricing configuration (1121 lines)

### Concurrency Control

- **`lib/adaptive-concurrency.js`** - AIMD-based per-model concurrency controller (465 lines)
- **`lib/rate-limiter.js`** - Token bucket rate limiting

### Metrics

- **`lib/stats-aggregator.js`** - Real-time metrics collection
- **`lib/ring-buffer.js`** - O(1) latency tracking for memory efficiency (204 lines)
- **`lib/stats/persistence.js`** - File I/O for stats storage (236 lines)

### Dashboard

- **`lib/dashboard.js`** - Dashboard HTML/CSS/JS generation

## Data Flow

1. **Request Arrives** - HTTP server receives request
2. **Model Routing** - Complexity-based model classification and potential rerouting
3. **Queue Check** - Request enters queue if all keys busy
4. **Rate Limit** - Per-key rate limiter checks allowance
5. **Adaptive Concurrency** - Per-model limit check (if in enforce mode)
6. **Key Selection** - Health-weighted selection from available keys (not just round-robin)
7. **Circuit Check** - Circuit breaker validates key state
8. **Proxy** - Request forwarded to target API
9. **Retry** - On failure, exponential backoff with jitter
10. **Response** - Response returned to client
11. **Metrics** - All events recorded via RingBuffer for efficiency
12. **Cost Tracking** - Token usage recorded with pricing lookup

## Circuit Breaker

```
                    ┌─────────┐
                    │ CLOSED │  (normal operation)
                    └────┬────┘
                         │ failures > threshold
                         v
                    ┌─────────┐
                    │  OPEN   │  (key disabled)
                    └────┬────┘
                         │ cooldown elapsed
                         v
                 ┌─────────────┐
                 │ HALF_OPEN   │  (testing recovery)
                 └──────┬──────┘
                        │
         ┌──────────────┴──────────────┐
         │                             │
    success                        failure
         │                             │
         v                             v
    ┌─────────┐                   ┌─────────┐
    │ CLOSED  │                   │  OPEN   │
    └─────────┘                   └─────────┘
```

## Adaptive Concurrency (AIMD)

The AIMD controller dynamically adjusts per-model concurrency limits based on 429 feedback:

```
           ┌─────────────────────────────────┐
           │    Current Limit: N per model   │
           └───────────────┬─────────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
         429 Received              Success
              │                         │
              v                         v
     ┌─────────────────┐      ┌─────────────────┐
     │ Multiplicative  │      │  Additive       │
     │ Decrease        │      │  Increase       │
     │ N = N × 0.5     │      │  N = N + 1      │
     └─────────────────┘      └─────────────────┘
              │                         │
              v                         v
     ┌─────────────────┐      ┌─────────────────┐
     │ Start Cooldown  │      │  Respect Max    │
     │ (5s recovery)   │      │  Limit          │
     └─────────────────┘      └─────────────────┘
```

**Modes:**
- `observe_only` (default): Monitors and logs adjustments without enforcing
- `enforce`: Actively applies calculated limits to requests

## Clustering

GLM Proxy supports multi-worker clustering for high throughput:

```
┌──────────────┐
│   Master     │
│   Process    │
└──────┬───────┘
       │
       ├─────> ┌─────────┐
       │       │ Worker 1 │
       │       └─────────┘
       │
       ├─────> ┌─────────┐
       │       │ Worker 2 │
       │       └─────────┘
       │
       ├─────> ┌─────────┐
       │       │ Worker 3 │
       │       └─────────┘
       │
       └─────> ┌─────────┐
               │ Worker 4 │
               └─────────┘
```

**Configuration:**
- `GLM_MAX_WORKERS` - Maximum number of workers
- `GLM_NO_CLUSTER=1` - Disable clustering

## Event System

GLM Proxy emits events for monitoring and integration:

- `request` - Incoming request
- `response` - Response received
- `error` - Error occurred
- `retry` - Retry attempt
- `circuit:open` - Circuit opened
- `circuit:closed` - Circuit closed

See [events.md](./events.md) for detailed event documentation.

## Testing

Test suite uses Jest:

```bash
npm test                    # Run tests
npm run test:verbose       # Run with coverage
```

See [testing.md](./testing.md) for test strategy and coverage information.

## Security Considerations

- API keys stored in separate `api-keys.json` (git-ignored)
- No credentials in logs
- Circuit breaker prevents cascading failures
- Rate limiting prevents abuse

See [Security](../operations/security.md) for more details.
