# Dashboard Guide

The AI Proxy includes a comprehensive real-time dashboard for monitoring requests, managing routing, and diagnosing issues.

## Accessing the Dashboard

Once the proxy is running, access the dashboard at:

```
http://127.0.0.1:18765/dashboard
```

![Dashboard Overview](../screenshots/overview.png)

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

- Green cells indicate healthy keys
- Color intensity shows request volume
- Red cells indicate failing or circuit-broken keys

![Keys Heatmap](../screenshots/sections/keys-heatmap.png)

### Cost Panel

Track your API spending in real-time:

- Current session cost
- Projected daily/monthly costs
- Per-model cost breakdown

![Cost Panel](../screenshots/sections/cost-panel.png)

### Request Charts

Real-time charts showing request patterns:

- **Request Rate** - Requests per minute over time
- **Latency** - Response time distribution
- **Error Rate** - Failed request percentage

![Charts](../screenshots/sections/charts.png)

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

### Model Routing Page

Configure and monitor model routing:

![Routing Page](../screenshots/routing.png)

#### Tier Builder

Drag-and-drop interface for configuring routing tiers:

![Tier Builder](../screenshots/routing/tier-builder.png)

### System Page

Diagnostics and advanced metrics:

![System Page](../screenshots/system.png)

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

Toggle between dark and light themes:

![Dark Theme](../screenshots/themes/dark-theme.png)

![Light Theme](../screenshots/themes/light-theme.png)

### Density Modes

Adjust the layout density:

- **Compact** - More information in less space
- **Comfortable** - Balanced spacing (default)

![Compact Density](../screenshots/density/compact.png)

![Comfortable Density](../screenshots/density/comfortable.png)

## Keyboard Shortcuts

Press `?` to see all keyboard shortcuts:

![Keyboard Shortcuts Modal](../screenshots/modals/keyboard-shortcuts.png)

### Essential Shortcuts

| Shortcut | Action |
|----------|--------|
| `?` | Show keyboard shortcuts |
| `g` + `o` | Go to Overview |
| `g` + `r` | Go to Routing |
| `g` + `s` | Go to System |
| `l` | Toggle live stream |
| `t` | Toggle theme |
| `1-5` | Switch dock tabs |

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

The dashboard adapts to different screen sizes:

### Mobile (375px)

![Mobile View](../screenshots/responsive/mobile-375px.png)

### Tablet (768px)

![Tablet View](../screenshots/responsive/tablet-768px.png)

### Desktop (1920px)

![Desktop View](../screenshots/responsive/desktop-1920px.png)

## Navigation

The dashboard supports URL-based navigation for bookmarking and sharing:

- `/dashboard` - Overview page (default)
- `/dashboard#requests` - Requests page
- `/dashboard#routing` - Model Routing page
- `/dashboard#system` - System page

Sub-pages are also supported:
- `/dashboard#requests/live` - Live stream tab
- `/dashboard#requests/traces` - Traces tab
- `/dashboard#routing/tiers` - Tiers sub-tab

## Next Steps

- [Configuration](./configuration.md) - Customize proxy settings
- [Monitoring](./monitoring.md) - API endpoints for monitoring
- [Model Routing](../features/model-routing.md) - Detailed routing configuration
