# AI Proxy

**A smart middleman between your applications and AI services.**

If you have multiple API keys and want to use them efficiently without hitting rate limits, this tool automatically distributes your requests across all your keys, handles errors gracefully, and shows you exactly what's happening in real-time.

Built for [Z.AI](https://z.ai) subscriptions but compatible with any Anthropic-compatible API endpoint.

## What Does This Do?

**In simple terms:** Imagine you have 5 API keys. Instead of using just one until it hits a limit, this tool spreads your requests across all 5 keys automatically. If one key fails, it automatically switches to another. You get a dashboard to see everything happening in real-time.

**Key benefits:**
- **Never hit rate limits** — Spreads requests across multiple API keys
- **Automatic failover** — If one key fails, switches to another instantly
- **See what's happening** — Real-time dashboard shows requests, costs, and health
- **Works with your existing tools** — Just change one setting in your app

## What's New in v2.4

The latest release includes major improvements:

- **Adaptive Concurrency** — Automatically slows down when hitting rate limits, speeds up when clear
- **Key Scheduler** — Smarter key selection that considers health and performance
- **Model Routing** — Automatically routes requests to appropriate AI models based on complexity
- **Diagnostics Tab Fix** — Dashboard now properly shows auth requirements for sensitive data
- **Improved Dashboard** — Better visual feedback and error states

See [CHANGELOG.md](./CHANGELOG.md) for full details.

## Prerequisites

Before you start, make sure you have:

- **Node.js** (version 18 or higher) — [Download here](https://nodejs.org/)
- **API keys** from [Z.AI](https://z.ai) or another Anthropic-compatible provider
- A terminal/command prompt

**To check if Node.js is installed:**
```bash
node --version
```
You should see something like `v20.x.x`. If not, install Node.js first.

## Quick Start

### 1. Download and Install

```bash
# Clone or download this project
git clone https://github.com/RicherTunes/ai-proxy.git
cd ai-proxy

# Install dependencies (this may take a minute)
npm install
```

### 2. Add Your API Keys

Create a file called `api-keys.json` in the project folder:

```json
{
  "keys": [
    "your-first-api-key.here",
    "your-second-api-key.here"
  ],
  "baseUrl": "https://api.z.ai/api/anthropic"
}
```

> **Where do I get API keys?** Sign up at [Z.AI](https://z.ai) and create API keys in your dashboard.

### 3. Start the Proxy

```bash
npm start
```

You should see something like:
```
[INFO] GLM Proxy starting...
[INFO] Loaded 2 API keys
[INFO] Server listening on http://127.0.0.1:18765
```

### 4. Check It's Working

Open your browser and go to: **http://127.0.0.1:18765/dashboard**

You should see the dashboard with your keys listed.

### 5. Connect Your Application

Change your application to use the proxy instead of connecting directly:

**For Claude Code CLI:**
```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18765
```

**For Python (Anthropic SDK):**
```python
import anthropic
client = anthropic.Anthropic(base_url="http://127.0.0.1:18765")
```

**For any application using Anthropic API:**
Just change the API endpoint from `https://api.anthropic.com` to `http://127.0.0.1:18765`

That's it! Your requests now go through the proxy automatically.

## Dashboard

After starting the proxy, open **http://127.0.0.1:18765/dashboard** in your browser to see:

- **Overview** — Total requests, success rate, current costs
- **Keys** — Health status of each API key, how many requests each has handled
- **Requests** — Live feed of requests going through
- **Routing** — Which AI models are being used

## Having Problems?

**Proxy won't start?**
- Make sure you ran `npm install` first
- Check that `api-keys.json` exists and has valid JSON format
- Verify your API keys are correct

**Dashboard shows errors?**
- Make sure the proxy is running (you should see log output in your terminal)
- Try refreshing the page
- Check your browser's developer console (F12) for error messages

**Requests failing?**
- Verify your API keys are valid and not expired
- Check the dashboard to see if keys show as "healthy"
- Look at the terminal output for error messages

For more help, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Features

For advanced users, here's the full feature list:

- **Multi-Key Load Balancing** — Distributes requests across keys based on health
- **Automatic Failover** — If a key fails, switches to healthy ones
- **Rate Limit Handling** — Slows down when hitting limits, speeds up when clear
- **Cost Tracking** — See exactly how much each request costs
- **Real-Time Dashboard** — Monitor everything visually
- **Streaming Support** — Works with streaming responses
- **Hot Reload** — Add new keys without restarting

## Glossary

New to proxies? Here are some terms you might see:

| Term | What It Means |
|------|---------------|
| **Proxy** | A middleman that sits between your app and the API |
| **API Key** | A password that lets you use an API service |
| **Rate Limit** | The maximum number of requests you can make per minute/hour |
| **429 Error** | "Too many requests" — you hit the rate limit |
| **Circuit Breaker** | Automatic safety switch that stops using a broken key |
| **Dashboard** | Web page that shows what's happening in real-time |
| **Endpoint** | A specific URL you can make requests to |
| **Upstream** | The API service you're connecting to (like Z.AI) |

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
| `GLM_MAX_CONCURRENCY_PER_KEY` | `5` | Max concurrent requests per key |
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
| `GLM_POOL_COOLDOWN_MAX` | `10000` | Max pool cooldown (ms) |
| `GLM_HISTOGRAM_ENABLED` | `true` | Enable latency histogram |
| `GLM_COST_ENABLED` | `true` | Enable cost tracking |
| `GLM_TRACE_ENABLED` | `true` | Enable request tracing |
| `GLM_ADMIN_AUTH_ENABLED` | `false` | Enable admin authentication |
| `GLM_MAX_429_ATTEMPTS` | `3` | Max 429 retry attempts per request |
| `GLM_ALLOW_TIER_DOWNGRADE` | `false` | Allow tier downgrade on 429 |
| `GLM_GLM5_ENABLED` | `true` | Enable GLM-5 routing (shadow-only at 0% preference by default) |

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

> See [Architecture](./docs/developer-guide/architecture.md#circuit-breaker) for diagrams and [Configuration](./docs/user-guide/configuration.md#circuit-breaker) for detailed settings.

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
