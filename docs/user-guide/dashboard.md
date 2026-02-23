---
layout: default
title: Dashboard Guide
---

# Dashboard Guide

The AI Proxy includes a comprehensive real-time dashboard for monitoring requests, managing routing, and diagnosing issues.

> **Related:**
> - [Monitoring Guide](./monitoring.md) - API endpoints for health and stats
> - [Configuration Guide](./configuration.md) - Dashboard and proxy settings
> - [Events SSE Contract](../developer-guide/events.md) - Real-time event streaming
> - [Metrics Reference](../reference/metrics.md) - Prometheus metrics

## Accessing the Dashboard

Once the proxy is running, access the dashboard at:

```
http://127.0.0.1:18765/dashboard
```

![Dashboard Overview](../screenshots/overview.png)

## Dashboard Navigation

### Page Navigation Tabs

Switch between main dashboard pages using the navigation tabs in the header:

![Page Navigation Tabs](../screenshots/components/page-nav-tabs.png)

| Tab | Description |
|-----|-------------|
| **Overview** | Key metrics, charts, and live stream |
| **Requests** | Live traces, logs, queue, and circuit status |
| **Routing** | Model routing configuration and tier management |
| **System** | Diagnostics, error breakdown, and health score |

### Connection Status

The header shows the live connection status to the upstream API:

![Connection Status](../screenshots/components/connection-status.png)

- **Green dot** - Connected and receiving events
- **Yellow dot** - Connected but no recent events
- **Red dot** - Disconnected or connection error

### Pause/Resume Control

Pause the proxy to stop accepting new requests (useful for maintenance):

![Pause Button](../screenshots/components/pause-button.png)

When paused, all incoming requests return `503 Service Unavailable` until resumed.

## Dashboard Sections

### Health Ribbon

The top ribbon shows key health metrics at a glance:

- **Uptime** - How long the proxy has been running
- **Success Rate** - Percentage of successful requests
- **Requests/min** - Current request rate
- **Active Connections** - Currently processing requests

![Health Ribbon](../screenshots/sections/health-ribbon.png)

### Keys Heatmap

Visual representation of API key health and performance:

![Keys Heatmap Component](../screenshots/components/keys-heatmap.png)

- **Green cells** - Healthy keys with high success rates
- **Yellow cells** - Keys with warnings or degraded performance
- **Red cells** - Failing or circuit-broken keys
- **Color intensity** - Indicates request volume (brighter = more requests)
- **Pulsing border** - Key has in-flight requests

### Cost Panel

Track your API spending in real-time:

![Cost Panel](../screenshots/sections/cost-panel.png)

- Current session cost
- Projected daily/monthly costs
- Per-model cost breakdown

### Request Charts

Real-time charts showing request patterns:

![Request Rate Chart](../screenshots/components/request-rate-chart.png)
![Latency Chart](../screenshots/components/latency-chart.png)

- **Request Rate** - Requests per minute over time
- **Latency** - Response time distribution (P50, P95, P99)
- **Error Rate** - Failed request percentage

## Main Pages

### Overview Page

The default landing page shows all key metrics and the live request stream.

![Dashboard Overview](../screenshots/overview.png)

### Requests Page

Monitor live and historical requests:

- **Live Stream** - Real-time incoming requests
- **Traces** - Detailed request traces
- **Logs** - Application logs
- **Queue** - Request queue status
- **Circuit** - Circuit breaker states

![Requests Page](../screenshots/requests.png)

### Traces Tab

View detailed request information including timing, model used, and retry attempts:

![Trace Table](../screenshots/components/trace-table.png)

### Logs Tab

Application-level logs for debugging:

![Log Entries](../screenshots/components/log-entries.png)

### Model Routing Page

Configure and monitor model routing:

![Routing Page](../screenshots/routing.png)

#### Model List

View all configured models with their pricing, tier assignments, and concurrency limits:

![Model List](../screenshots/components/model-list.png)

#### Tier Builder

Drag-and-drop interface for configuring routing tiers:

![Tier Builder](../screenshots/routing/tier-builder.png)

### System Page

Diagnostics and advanced metrics:

![System Page](../screenshots/system.png)

#### Circuit Breaker Indicators

View the current state of all circuit breakers:

![Circuit Indicators](../screenshots/components/circuit-indicators.png)

- **Green** - Closed (normal operation)
- **Yellow** - Half-Open (testing recovery)
- **Red** - Open (circuit tripped, requests blocked)

#### Error Breakdown

Categorized error analysis:

![Error Breakdown](../screenshots/system/error-breakdown.png)

#### Retry Analytics

See how retries are performing:

![Retry Analytics](../screenshots/system/retry-analytics.png)

## Live Stream Panel

The bottom drawer contains the live request stream and related tabs:

### Collapsed View

![Live Stream Collapsed](../screenshots/panels/live-collapsed.png)

### Expanded View

![Live Stream Expanded](../screenshots/panels/live-expanded.png)

### Dock Tabs

Switch between different views:

| Tab | Description |
|-----|-------------|
| **Live** | Real-time request stream |
| **Traces** | Detailed request traces |
| **Logs** | Application logs |
| **Queue** | Request queue status |
| **Circuit** | Circuit breaker states |

![Traces Tab](../screenshots/dock-tabs/traces.png)
![Logs Tab](../screenshots/dock-tabs/logs.png)
![Queue Tab](../screenshots/dock-tabs/queue.png)
![Circuit Tab](../screenshots/dock-tabs/circuit.png)

## Theme and Display Options

### Themes

The dashboard supports both **dark** and **light** themes to match your preference and environment:

![Theme Toggle](../screenshots/components/theme-toggle.png)

**Dark Theme** (default):

![Dark Theme](../screenshots/themes/dark-theme.png)

- Reduces eye strain in low-light environments
- Better for long coding sessions
- Lower power consumption on OLED displays

**Light Theme**:

![Light Theme](../screenshots/themes/light-theme.png)

- Better visibility in bright environments
- Matches traditional light-mode applications
- Higher contrast for some users

**How to Toggle:**

- Click the theme toggle button (🌙/☀️) in the header
- Use keyboard shortcut: Press `T`
- Theme preference is saved in your browser

### Density Modes

Adjust the layout density using the density selector:

![Density Selector](../screenshots/components/density-selector.png)

- **Compact** - More information in less space
- **Comfortable** - Balanced spacing (default)

![Compact Density](../screenshots/density/compact.png)
![Comfortable Density](../screenshots/density/comfortable.png)

### Time Range Selector

Change the time window for charts and statistics:

![Time Range Selector](../screenshots/components/time-range-selector.png)

Options: 5m, 15m, 1h, 6h, 24h, 7d

## Keyboard Shortcuts

Press `?` to see all keyboard shortcuts:

![Keyboard Shortcuts Modal](../screenshots/modals/keyboard-shortcuts.png)

### Essential Shortcuts

| Shortcut | Action |
|----------|--------|
| `?` | Show keyboard shortcuts |
| `P` | Pause/resume proxy |
| `R` | Switch to Requests page |
| `T` | Toggle theme |
| `E` | Toggle density |
| `L` | Toggle live stream panel |
| `F` | Toggle focus mode |
| `Ctrl+K` | Open search |
| `g` + `o` | Go to Overview |
| `g` + `r` | Go to Routing |
| `g` + `s` | Go to System |
| `1-5` | Switch dock tabs |
| `Esc` | Close modals/drawers |

## Progressive Disclosure

Advanced sections are collapsed by default to reduce visual clutter:

### Advanced Statistics

Lifetime stats, AIMD concurrency, and predictions:

![Advanced Stats Collapsed](../screenshots/progressive/advanced-stats-collapsed.png)
![Advanced Stats Expanded](../screenshots/progressive/advanced-stats-expanded.png)

### Process & Scheduler

System health and scheduler metrics:

![Process Health Collapsed](../screenshots/progressive/process-health-collapsed.png)
![Process Health Expanded](../screenshots/progressive/process-health-expanded.png)

## Responsive Design

The dashboard is fully responsive and adapts to different screen sizes:

### Mobile (375px)

![Mobile View](../screenshots/responsive/mobile-375px.png)

**Mobile-specific behavior:**
- Navigation collapses into a hamburger menu
- Charts resize to fit narrow screens
- Live stream panel becomes full-width when expanded
- Keyboard shortcuts adapted for touch screens

### Tablet (768px)

![Tablet View](../screenshots/responsive/tablet-768px.png)

**Tablet behavior:**
- Side-by-side layout for some panels
- Touch-friendly button sizes
- Optimized chart dimensions

### Desktop (1920px)

![Desktop View](../screenshots/responsive/desktop-1920px.png)

**Desktop features:**
- Full multi-column layout
- Wider charts with more data points
- Side-by-side panels and widgets
- Maximum information density

## Navigation

The dashboard supports URL-based navigation for bookmarking and sharing:

- `/dashboard` - Overview page (default)
- `/dashboard#requests` - Requests page
- `/dashboard#routing` - Model Routing page
- `/dashboard#system` - System page

Sub-pages are also supported:

- `/dashboard#requests/live` - Live stream tab
- `/dashboard#requests/traces` - Traces tab
- `/dashboard#requests/logs` - Logs tab
- `/dashboard#requests/queue` - Queue tab
- `/dashboard#requests/circuit` - Circuit tab

## Dashboard Glossary

Common terms used in the dashboard:

| Term | Definition |
|------|------------|
| **Circuit Breaker** | Safety mechanism that temporarily disables failing API keys |
| **CLOSED** | Circuit breaker state indicating healthy operation |
| **OPEN** | Circuit breaker state indicating the key is disabled due to failures |
| **HALF_OPEN** | Circuit breaker testing if a previously failed key has recovered |
| **In-Flight** | Requests currently being processed (not yet completed) |
| **P50/P95/P99** | Latency percentiles (50%, 95%, 99% of requests are faster than this) |
| **RPM** | Requests Per Minute - throughput metric |
| **Tier** | Model classification (Light/Medium/Heavy) based on capability and cost |
| **Upstream** | The target API service (e.g., Z.ai) that the proxy forwards requests to |
| **Downstream** | Your application making requests through the proxy |
| **SSE** | Server-Sent Events - real-time push from server to dashboard |
| **Backpressure** | System load indicator showing how many requests are queued/processing |
| **Keys Heatmap** | Visual grid showing health status of all API keys |
| **Trace** | Detailed record of a single request's lifecycle |
| **Health Score** | Composite metric indicating overall system health (0-100) |
| **AIMD** | Additive Increase/Multiplicative Decrease - adaptive concurrency algorithm |

## Dashboard States

### Normal Operation

When everything is working correctly:
- All key cells show green in the heatmap
- Success rate is above 95%
- Connection status shows green dot
- No circuit breakers are OPEN

### Error States

**Connection Issues:**

When the proxy cannot connect to the upstream API:
- Connection status shows red dot
- Keys may transition to OPEN state
- Error count increases in the system page

**Rate Limited (429):**

When API rate limits are hit:
- Keys show yellow/warning in heatmap
- Retry count increases
- Queue may fill up with waiting requests

**All Keys Unhealthy:**

When all API keys are failing:
- All keys show red in heatmap
- Dashboard displays warning banner
- Requests return 503 Service Unavailable

### Interpreting the Health Score

The system page shows an overall health score (0-100):

| Score Range | Status | Action |
|-------------|--------|--------|
| 90-100 | Excellent | No action needed |
| 70-89 | Good | Monitor for trends |
| 50-69 | Degraded | Check error breakdown |
| 0-49 | Critical | Immediate attention required |

### Troubleshooting with the Dashboard

> **See Also:** [Troubleshooting Guide](../../TROUBLESHOOTING.md) for detailed problem solving.

**Common diagnostic steps:**

1. **Check Keys Heatmap** - Identify which keys are unhealthy
2. **View Error Breakdown** - Understand what types of errors are occurring
3. **Check Retry Analytics** - See if retries are succeeding
4. **Review Logs Tab** - Get detailed error messages
5. **Check Queue Status** - See if requests are backing up

## Next Steps

> **More Guides:**
> - [Configuration](./configuration.md) - Customize proxy settings
> - [Monitoring](./monitoring.md) - API endpoints for monitoring
> - [Model Routing](../features/model-routing.md) - Detailed routing configuration
> - [Troubleshooting](../../TROUBLESHOOTING.md) - Common issues and solutions
