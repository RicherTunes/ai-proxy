# Getting Started

Quick start guide for GLM Proxy.

> **Note:** This guide provides detailed setup instructions. For a quick overview, see the root [README.md](../../README.md).

## What is GLM Proxy?

GLM Proxy is a high-performance API proxy for [Z.AI GLM](https://z.ai) subscriptions with automatic key rotation, circuit breaker protection, and clustering support.

### Key Features

For a complete feature list, see [README.md](../../README.md#features).

## Installation

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure API Keys

Create `api-keys.json` with your Z.AI GLM API keys:

```json
{
  "keys": [
    "your-api-key-1.your-secret-1",
    "your-api-key-2.your-secret-2"
  ],
  "baseUrl": "https://api.z.ai/api/anthropic"
}
```

### 3. Start the Proxy

```bash
npm start
```

The proxy will start on `http://127.0.0.1:18765` by default.

## Configuration

Your client should be configured to point to the proxy:

```bash
# Example: Claude CLI
export ANTHROPIC_BASE_URL=http://127.0.0.1:18765

# Example: Python SDK
client = anthropic.Anthropic(base_url="http://127.0.0.1:18765")
```

## Quick Verification

Test that the proxy is running:

```bash
curl http://127.0.0.1:18765/health
```

Expected response:

```json
{
  "status": "OK",
  "healthyKeys": 2,
  "totalKeys": 2
}
```

## Next Steps

- [Configuration](./configuration.md) - All configuration options
- [Monitoring](./monitoring.md) - Health checks and statistics
- [Architecture](../developer-guide/architecture.md) - System design overview
