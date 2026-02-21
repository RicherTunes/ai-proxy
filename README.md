# AI Proxy

High-performance API proxy for AI providers with multi-key load balancing, circuit breaker protection, adaptive concurrency control, and a real-time monitoring dashboard.

Built for [Z.AI](https://z.ai) subscriptions but compatible with any Anthropic-compatible API endpoint.

## Features

- **Multi-Key Load Balancing** — Health-aware distribution across multiple API keys with weighted scoring
- **Circuit Breaker** — Automatic key isolation on failures with half-open recovery testing
- **Adaptive Concurrency (AIMD)** — Dynamically adjusts per-model concurrency limits based on 429 feedback
- **Rate Limiting** — Per-key token bucket with burst support
- **Request Queue** — Backpressure-aware queueing when all keys are busy, with configurable timeout
- **Retry with Backoff** — Exponential backoff with jitter on transient failures
- **Model Routing** — Complexity-aware tiered model mapping with per-key overrides and cost tracking
- **Key Scheduler** — Intelligent key selection with health-weighted scoring and drift detection
- **Cost Tracking** — Per-model cost tracking with external pricing configuration
- **Token Tracking** — Real-time input/output token counting with cost estimation
- **Hot Reload** — Update API keys without restart
- **Clustering** — Multi-worker process support for high throughput
- **Real-Time Dashboard** — Full monitoring UI with charts, traces, and controls
- **SSE Streaming** — Full support for streaming responses with proper backpressure

## Dashboard

The built-in dashboard provides real-time visibility into proxy health, request flow, and key status:

- Live request/response monitoring with trace inspection
- Per-key health scores, circuit breaker states, and latency heatmaps
- Historical charts for throughput, latency, and error rates
- Model routing configuration with per-key override management
- Cost tracking and usage monitoring
- Process health, scheduler status, and replay queue visibility

Access it at `http://127.0.0.1:18765/dashboard` after starting the proxy.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure API Keys

Copy the example and add your keys:

```bash
cp api-keys.json.example api-keys.json
```

Edit `api-keys.json`:

```json
{
  "keys": [
    "your-key-id-1.your-secret-1",
    "your-key-id-2.your-secret-2"
  ],
  "baseUrl": "https://api.z.ai/api/anthropic"
}
```

### 3. Start the Proxy

```bash
npm start
```

The proxy will start on `http://127.0.0.1:18765` by default.

### 4. Configure Your Client

Point your Anthropic/Claude client to the proxy:

```bash
# Claude Code CLI
export ANTHROPIC_BASE_URL=http://127.0.0.1:18765

# Python SDK
client = anthropic.Anthropic(base_url="http://127.0.0.1:18765")
```

## Configuration

### Environment Variables

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
| `GLM_USE_WEIGHTED_SELECTION` | `true` | Health-weighted key selection vs round-robin |
| `GLM_SLOW_KEY_THRESHOLD` | `2.0` | Latency multiplier for slow key detection |
| `GLM_MAX_CONSECUTIVE_HANGUPS` | `5` | Max consecutive hangups before recreation |
| `GLM_POOL_COOLDOWN_MAX` | `30000` | Max pool cooldown (ms) |
| `GLM_HISTOGRAM_ENABLED` | `true` | Enable latency histogram |
| `GLM_COST_ENABLED` | `true` | Enable cost tracking |
| `GLM_TRACE_ENABLED` | `true` | Enable request tracing |
| `GLM_ADMIN_AUTH_ENABLED` | `true` | Enable admin authentication |
| `GLM_MAX_429_ATTEMPTS` | `3` | Max 429 retry attempts per request |
| `GLM_ALLOW_TIER_DOWNGRADE` | `true` | Allow tier downgrade on 429 |
| `GLM_GLM5_ENABLED` | `true` | Enable GLM-5 shadow mode |

### Adaptive Concurrency (AIMD)

Dynamically adjusts per-model concurrency limits based on 429 feedback:

| Setting | Default | Description |
|---------|---------|-------------|
| `adaptiveConcurrency.enabled` | `true` | Enable adaptive concurrency |
| `adaptiveConcurrency.mode` | `observe_only` | 'observe_only' or 'enforce' |
| `adaptiveConcurrency.tickIntervalMs` | `2000` | Adjustment interval |
| `adaptiveConcurrency.decreaseFactor` | `0.5` | Multiplicative decrease on 429 |
| `adaptiveConcurrency.recoveryDelayMs` | `5000` | Wait after last 429 before growth |

Configured via the `adaptiveConcurrency` object in config file.

### Model Routing

Complexity-aware routing with three tiers:

| Setting | Default | Description |
|---------|---------|-------------|
| `modelRouting.enabled` | `true` | Enable model routing |
| `modelRouting.tiers.light.models` | `glm-4.5-air`, `glm-4.5-flash`, `glm-4.7-flash` | Light tier models |
| `modelRouting.tiers.medium.models` | `glm-4.5` | Medium tier models |
| `modelRouting.tiers.heavy.models` | `glm-5`, `glm-4.7`, `glm-4.6` | Heavy tier models |

See [Model Routing](./docs/features/model-routing.md) for full details.

### Key Selection

Intelligent health-score weighted key selection:

| Setting | Default | Description |
|---------|---------|-------------|
| `keySelection.useWeightedSelection` | `true` | Use health scores vs round-robin |
| `keySelection.healthScoreWeights.latency` | `40` | Latency weight (0-40) |
| `keySelection.healthScoreWeights.successRate` | `40` | Success rate weight (0-40) |
| `keySelection.healthScoreWeights.errorRecency` | `20` | Error recency weight (0-20) |

### api-keys.json Format

```json
{
  "keys": [
    "key-id-1.secret-1",
    "key-id-2.secret-2"
  ],
  "baseUrl": "https://api.z.ai/api/anthropic"
}
```

## API Endpoints

### Admin

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check with key status |
| `GET /stats` | Real-time statistics and key metrics |
| `GET /persistent-stats` | Historical usage statistics |
| `GET /backpressure` | Current load and queue information |
| `GET /history` | Request history time-series |
| `GET /histogram` | Latency distribution histogram |
| `GET /cost-stats` | Token usage and cost breakdown |
| `GET /traces` | Request trace search and inspection |
| `GET /model-routing` | Current model routing configuration |
| `PUT /model-routing` | Update model routing rules |
| `POST /reload` | Hot reload API keys from disk |
| `GET /dashboard` | Monitoring dashboard UI |

### Proxy

All other requests are proxied to the target API with automatic key selection, retry, and streaming support.

## Circuit Breaker

| State | Description |
|-------|-------------|
| `CLOSED` | Normal operation, requests flow through |
| `OPEN` | Key disabled after failures, requests skip this key |
| `HALF_OPEN` | Testing recovery with a single request |

**Transitions:**
- `CLOSED -> OPEN`: After threshold failures within window
- `OPEN -> HALF_OPEN`: After cooldown period
- `HALF_OPEN -> CLOSED`: Test request succeeds
- `HALF_OPEN -> OPEN`: Test request fails

## Running in Production

### Single Process

```bash
NO_CLUSTER=1 npm start
```

### With PM2

```bash
npm run start:pm2
```

Or configure directly:

```bash
pm2 start ecosystem.config.js
pm2 save
```

### With systemd

```ini
[Unit]
Description=AI Proxy
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/ai-proxy
ExecStart=/usr/bin/node proxy.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Development

### Run Tests

```bash
npm test              # Unit tests with coverage
npm run test:verbose  # Verbose output
npm run test:e2e      # Playwright E2E tests
npm run test:stress   # Stress tests
npm run test:all      # Everything
```

### Load Testing

```bash
npm run load:smoke    # Quick 60s test at 5 rps
npm run load:medium   # 2min at 20 rps
npm run load:heavy    # 5min at 50 rps
```

### Project Structure

```
proxy.js                  # Entry point
lib/
  index.js                # Module exports
  config.js               # Configuration with env var overrides
  logger.js               # Structured logging
  proxy-server.js         # HTTP server, routing, admin endpoints
  request-handler.js      # Proxy logic with retry and streaming
  key-manager.js          # Key rotation, selection, health scoring
  key-scheduler.js        # Intelligent key selection with health weighting
  model-router.js         # Complexity-aware tiered model routing
  cost-tracker.js         # Per-model cost tracking with pricing.json
  circuit-breaker.js      # Per-key circuit breaker state machine
  rate-limiter.js         # Token bucket rate limiter
  adaptive-concurrency.js # AIMD-based per-model concurrency control
  ring-buffer.js          # O(1) latency tracking for memory efficiency
  stats-aggregator.js     # Metrics collection and aggregation
  dashboard.js            # Dashboard generation
  pricing-loader.js       # Pricing configuration loader
  proxy/
    router.js             # Route registry and dispatch
    controllers/          # 15 controller files (health, auth, etc.)
  stats/
    persistence.js        # File I/O for stats storage
public/
  js/                     # Dashboard frontend modules
  css/                    # Dashboard stylesheets
config/
  pricing.json            # Model pricing data (30+ models)
  route-policies.json     # Routing policies
  performance-baseline.json # Performance targets
test/                     # Jest + Playwright test suite
docs/                     # Documentation
```

## Documentation

Full documentation is available in the [`docs/`](./docs/) directory:

- **[Getting Started](./docs/user-guide/getting-started.md)** — Installation and quick start
- **[Configuration](./docs/user-guide/configuration.md)** — All configuration options
- **[Monitoring](./docs/user-guide/monitoring.md)** — Health checks and statistics
- **[Architecture](./docs/developer-guide/architecture.md)** — System design overview
- **[Model Routing](./docs/features/model-routing.md)** — Complexity-aware routing system
- **[Claude Code Setup](./docs/developer-guide/claude-code-setup.md)** — AI-assisted development
- **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** — Common issues and solutions
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — How to contribute

## License

MIT
