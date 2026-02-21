# Cost Tracking Admin API Quick Reference

## Dashboard Visualization

The Cost Panel in the dashboard provides real-time visibility into cost tracking:

![Cost Panel](../screenshots/sections/cost-panel.png)

## Base URL

```
http://your-server:port/admin/cost-tracking
```

## Authentication

All endpoints require admin authentication when enabled:

```bash
# Header-based authentication
curl -H "x-admin-token: YOUR_ADMIN_TOKEN" http://localhost:8080/admin/cost-tracking/config
```

## Endpoints

### GET /config

Get current cost tracking configuration.

**Response:**
- `rates` - Default pricing rates
- `modelRates` - Per-model pricing
- `budget` - Budget settings
- `saveDebounceMs` - Save debounce delay
- `persistPath` - Persistence file path

**Example:**
```bash
curl -H "x-admin-token: TOKEN" /admin/cost-tracking/config
```

---

### POST /config

Update cost tracking configuration.

**Request Body (all fields optional):**
```json
{
  "rates": {
    "inputTokenPer1M": 3.00,
    "outputTokenPer1M": 15.00
  },
  "modelRates": {
    "claude-opus-4": {
      "inputTokenPer1M": 15.00,
      "outputTokenPer1M": 75.00
    }
  },
  "budget": {
    "daily": 100,
    "monthly": 3000,
    "alertThresholds": [0.5, 0.8, 0.95, 1.0]
  },
  "saveDebounceMs": 5000
}
```

**Validation:**
- Rates must be non-negative numbers
- Budget thresholds must be 0-1

**Example:**
```bash
curl -X POST \
  -H "x-admin-token: TOKEN" \
  -H "content-type: application/json" \
  -d '{"budget": {"daily": 200}}' \
  /admin/cost-tracking/config
```

---

### GET /metrics

Get detailed cost tracking metrics.

**Response:**
```json
{
  "metrics": {
    "recordCount": 1500,
    "saveCount": 45,
    "lastSaveDuration": 12,
    "errorCount": 0,
    "estimatedMemoryKB": 245,
    "currentKeys": 42,
    "currentTenants": 5
  },
  "summary": {
    "periods": { "today": {...}, "thisMonth": {...} },
    "projection": {...}
  }
}
```

**Example:**
```bash
curl -H "x-admin-token: TOKEN" /admin/cost-tracking/metrics
```

---

### POST /flush

Force immediate save to disk.

**Response:**
```json
{
  "success": true,
  "message": "Cost tracking data flushed successfully",
  "timestamp": "2026-02-09T22:00:00.000Z"
}
```

**Use when:**
- Before server shutdown
- Before backup
- To ensure data persistence

**Example:**
```bash
curl -X POST \
  -H "x-admin-token: TOKEN" \
  /admin/cost-tracking/flush
```

---

### POST /reset

Reset all cost tracking data.

**⚠️ Warning:** Destructive operation, cannot be undone.

**Response:**
```json
{
  "success": true,
  "message": "Cost tracking data reset successfully",
  "timestamp": "2026-02-09T22:00:00.000Z"
}
```

**Example:**
```bash
curl -X POST \
  -H "x-admin-token: TOKEN" \
  /admin/cost-tracking/reset
```

## HTTP Status Codes

- `200` - Success
- `400` - Bad request (validation error)
- `401` - Unauthorized (missing/invalid token)
- `405` - Method not allowed
- `500` - Internal server error
- `503` - Service unavailable (cost tracking not enabled)

## Common Operations

### Update pricing for a new model

```bash
curl -X POST \
  -H "x-admin-token: TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "modelRates": {
      "new-model-name": {
        "inputTokenPer1M": 5.00,
        "outputTokenPer1M": 20.00
      }
    }
  }' \
  /admin/cost-tracking/config
```

### Set daily budget with alerts

```bash
curl -X POST \
  -H "x-admin-token: TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "budget": {
      "daily": 100,
      "alertThresholds": [0.5, 0.8, 0.95, 1.0]
    }
  }' \
  /admin/cost-tracking/config
```

### Save data before backup

```bash
curl -X POST \
  -H "x-admin-token: TOKEN" \
  /admin/cost-tracking/flush

# Then copy the persist file
cp cost-data.json backup/cost-data-$(date +%Y%m%d).json
```

### Check system health

```bash
curl -H "x-admin-token: TOKEN" /admin/cost-tracking/metrics | jq '.metrics'
```

## Error Handling

### Validation Error (400)

```json
{
  "error": "inputTokenPer1M must be a non-negative number"
}
```

### Authentication Error (401)

```json
{
  "error": "Authentication required"
}
```

### Service Unavailable (503)

```json
{
  "error": "Cost tracking not enabled"
}
```

## Best Practices

1. **Always authenticate** - Use admin tokens for all requests
2. **Validate changes** - Check config after updates
3. **Flush before shutdown** - Ensure data persistence
4. **Monitor metrics** - Check metrics regularly for issues
5. **Backup before reset** - Always backup before destructive operations
6. **Use thresholds wisely** - Set alerts at appropriate levels

## Security Notes

- All endpoints require admin authentication when enabled
- Sensitive operations (flush, reset) require POST method
- Input validation prevents malformed configuration
- All configuration changes are logged
- Rate limiting applies to prevent abuse
