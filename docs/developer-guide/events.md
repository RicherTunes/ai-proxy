# SSE Event Contract

This document describes the Server-Sent Events (SSE) contract for the `/events` (alias: `/requests/stream`) endpoint.

## Dashboard Visualization

The Requests page displays real-time events from the SSE stream:

![Requests Page](../screenshots/requests.png)

**Trace Table** - View individual request events:

![Trace Table](../screenshots/components/trace-table.png)

**Log Entries** - Real-time event log:

![Log Entries](../screenshots/components/log-entries.png)

## Connection

**Endpoint:** `GET /events` or `GET /requests/stream`

**Query Parameters:**
- `types` (optional): Comma-separated list of event types to subscribe to. Default: `all`
  - Valid types: `request`, `kpi`, `alert`, `all`

**Example:**
```
GET /events?types=request,kpi
```

## Event Contract

Every SSE message follows this contract:

```
event: <eventType>
data: <JSON payload>
```

### Standard Message Envelope

All event payloads include these fields:

| Field | Type | Description |
|-------|------|-------------|
| `seq` | number | Monotonically increasing sequence number (global, per-broadcast) |
| `ts` | number | Unix timestamp in milliseconds when event was created |
| `schemaVersion` | number | Schema version for backward compatibility (currently `1`) |
| `type` | string | Event type name (matches the `event:` line) |

Plus event-specific fields described below.

**Sequence Number Semantics:**
- `seq` is a global counter incremented once per broadcast event
- All clients subscribed to the same event type receive the same `seq` value
- The `connected` event has its own seq (unique to that client's connection)
- Clients can detect missed events by checking `seq > lastSeq + 1`
- Note: If you're subscribed to a subset of event types, you'll see gaps in seq (this is expected)

## Event Types

### `connected`

Sent immediately on connection. Includes recent requests for initial state hydration.

```json
{
  "seq": 1,
  "ts": 1706380800000,
  "schemaVersion": 1,
  "type": "connected",
  "clientId": "sse-1706380800000-abc123xyz",
  "subscribedTypes": ["all"],
  "recentRequests": [
    { /* request object */ }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `clientId` | string | Unique identifier for this SSE connection |
| `subscribedTypes` | string[] | Event types this client is subscribed to |
| `recentRequests` | object[] | Last 50 requests for initial state |

### `request`

Emitted for each proxied request completion. **Critical event** - clients that can't keep up may be disconnected.

```json
{
  "seq": 42,
  "ts": 1706380801234,
  "schemaVersion": 1,
  "type": "request",
  "requestId": "req-abc123",
  "keyIndex": 0,
  "keyPrefix": "sk-abc...",
  "status": 200,
  "latencyMs": 1234,
  "model": "claude-3-5-sonnet-20241022",
  "mappedModel": "glm-4-plus",
  "inputTokens": 1000,
  "outputTokens": 500,
  "cost": 0.0225,
  "costStatus": "calculated",
  "streaming": true,
  "retries": 0,
  "errorType": null,
  "timestamp": 1706380801234
}
```

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string | Unique request identifier |
| `keyIndex` | number | Index of the API key used |
| `keyPrefix` | string | First 8 characters of the key |
| `status` | number | HTTP status code returned to client |
| `latencyMs` | number | Total request duration in milliseconds |
| `model` | string | Model requested by client |
| `mappedModel` | string\|null | GLM model the request was mapped to |
| `inputTokens` | number\|null | Input tokens used |
| `outputTokens` | number\|null | Output tokens used |
| `cost` | number\|null | Calculated cost in USD (null if unavailable) |
| `costStatus` | string | One of: `calculated`, `unknown_model`, `no_tokens`, `unavailable` |
| `streaming` | boolean | Whether this was a streaming request |
| `retries` | number | Number of retries attempted |
| `errorType` | string\|null | Error classification if failed |
| `timestamp` | number | Request completion timestamp |

### `kpi`

Periodic lightweight stats snapshot. Emitted every 30 seconds. **Non-critical** - may be dropped under backpressure.

```json
{
  "seq": 100,
  "ts": 1706380830000,
  "schemaVersion": 1,
  "type": "kpi",
  "uptime": 3600000,
  "activeKeys": 3,
  "totalKeys": 5,
  "requests": 1234,
  "errors": 12,
  "activeConnections": 5,
  "sseClients": 2,
  "poolStatus": {
    "inCooldown": false,
    "cooldownRemainingMs": 0,
    "pool429Count": 0
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `uptime` | number | Proxy uptime in milliseconds |
| `activeKeys` | number | Number of healthy (CLOSED/HALF_OPEN) keys |
| `totalKeys` | number | Total configured keys |
| `requests` | number | Total requests processed |
| `errors` | number | Total errors |
| `activeConnections` | number | Current HTTP connections |
| `sseClients` | number | Connected SSE clients |
| `poolStatus` | object | Key pool rate limit state |
| `poolStatus.inCooldown` | boolean | Whether pool is in cooldown |
| `poolStatus.cooldownRemainingMs` | number | Milliseconds until cooldown ends |
| `poolStatus.pool429Count` | number | Count of pool-wide 429s |

### `alert`

Budget or threshold alerts. Emitted when cost thresholds are exceeded.

```json
{
  "seq": 150,
  "ts": 1706380900000,
  "schemaVersion": 1,
  "type": "alert",
  "alertType": "budget_warning",
  "severity": "warning",
  "message": "Daily budget 80% consumed",
  "details": {
    "period": "today",
    "current": 80.00,
    "limit": 100.00,
    "percentUsed": 80
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `alertType` | string | Alert classification |
| `severity` | string | One of: `info`, `warning`, `critical` |
| `message` | string | Human-readable alert message |
| `details` | object | Alert-specific details |

## Heartbeat

The server sends comment-line pings every 15 seconds to keep the connection alive:

```
: ping 1706380815000
```

These are SSE comments (start with `:`) and are not JSON events.

## Backpressure Handling

The server implements backpressure to protect against slow clients:

1. **Non-critical events** (`kpi`): Silently dropped when client buffer is full
2. **Critical events** (`request`): Client disconnected after 30 seconds of backpressure

Clients should:
- Process events quickly
- Track `seq` numbers to detect gaps
- Reconnect and hydrate from `recentRequests` if gaps detected

## Client Implementation

### Recommended Pattern

```javascript
const evtSource = new EventSource('/events?types=request,kpi');

let lastSeq = 0;

evtSource.addEventListener('connected', (e) => {
  const data = JSON.parse(e.data);
  // Hydrate initial state from recentRequests
  data.recentRequests.forEach(req => store.addRequest(req));
  lastSeq = data.seq;
});

evtSource.addEventListener('request', (e) => {
  const data = JSON.parse(e.data);
  // Check for gaps
  if (data.seq > lastSeq + 1) {
    console.warn(`Gap detected: ${lastSeq} -> ${data.seq}`);
    // Consider refetching state
  }
  lastSeq = data.seq;
  store.addRequest(data);
});

evtSource.addEventListener('kpi', (e) => {
  const data = JSON.parse(e.data);
  store.updateKPI(data);
});

evtSource.onerror = () => {
  // Reconnect logic with exponential backoff
};
```

### Gap Recovery

When a sequence gap is detected:

1. Continue processing new events
2. Fetch `/stats` for current aggregate state
3. Fetch `/requests?limit=100` for recent request history
4. Merge with local state

## Schema Versioning

The `schemaVersion` field enables backward-compatible evolution:

- **Version 1** (current): Initial schema as documented above
- Future versions will increment this number
- Clients should handle unknown fields gracefully

## Related Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /stats` | Full stats snapshot (for gap recovery) |
| `GET /requests` | Recent requests list (for gap recovery) |
| `GET /stats/models` | Per-model statistics |
| `GET /health` | Health check |
