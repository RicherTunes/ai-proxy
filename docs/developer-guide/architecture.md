# Architecture

System architecture overview for GLM Proxy.

## Overview

GLM Proxy is a Node.js-based HTTP proxy that provides intelligent request routing, load balancing, and fault tolerance for API requests to the Z.AI GLM service.

## System Components

```
┌─────────────────────────────────────────────────────────────┐
│                        GLM Proxy                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐     ┌─────────────────────────────┐   │
│  │   HTTP       │────>│  Request Handler             │   │
│  │   Server     │     │  (retry, backoff, timeout)   │   │
│  └──────────────┘     └──────────┬──────────────────┘   │
│                                     │                     │
│                                     v                     │
│  ┌─────────────────────────────────────────────────────┐ │
│  │            Key Manager & Circuit Breaker            │ │
│  │  - Round-robin key selection                       │ │
│  │  - Circuit state tracking                          │ │
│  │  - Health monitoring                               │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                         │                                 │
│                         v                                 │
│  ┌─────────────────────────────────────────────────────┐ │
│  │               Rate Limiter                          │ │
│  │            (Token bucket)                            │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                         │                                 │
│                         v                                 │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              Request Queue                           │ │
│  │          (Backpressure handling)                     │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                         │                                 │
└─────────────────────────┼─────────────────────────────────┘
                          │
                          v
              ┌───────────────────────┐
              │    Target API          │
              │    (api.z.ai)          │
              └───────────────────────┘
```

## Core Modules

### Entry Point

- **`proxy.js`** - Main server entry point, initializes all components

### Configuration

- **`lib/config.js`** - Configuration management from environment variables

### Logging

- **`lib/logger.js`** - Structured JSON logging

### Key Management

- **`lib/key-manager.js`** - API key rotation and circuit breaker logic
- **`lib/circuit-breaker.js`** - Circuit breaker implementation

### Request Handling

- **`lib/request-handler.js`** - Proxy logic with retries and backoff

### Rate Limiting

- **`lib/rate-limiter.js`** - Token bucket rate limiting

### Metrics

- **`lib/stats-aggregator.js`** - Real-time metrics collection
- **`lib/circular-buffer.js`** - Efficient latency tracking

## Data Flow

1. **Request Arrives** - HTTP server receives request
2. **Queue Check** - Request enters queue if all keys busy
3. **Rate Limit** - Per-key rate limiter checks allowance
4. **Key Selection** - Round-robin selection from healthy keys
5. **Circuit Check** - Circuit breaker validates key state
6. **Proxy** - Request forwarded to target API
7. **Retry** - On failure, exponential backoff with jitter
8. **Response** - Response returned to client
9. **Metrics** - All events recorded for statistics

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
