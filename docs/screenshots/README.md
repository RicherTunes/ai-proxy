---
layout: default
title: Dashboard Screenshots
---

# Dashboard Screenshots

This directory contains screenshots generated from E2E tests for documentation purposes.

> **Related:**
> - [Dashboard Guide](../user-guide/dashboard.md) - Complete dashboard walkthrough
> - [Testing Guide](../developer-guide/testing.md#e2e-testing-with-screenshots) - E2E test and screenshot generation
> - [Search Functionality](../search/README.md) - Documentation search index

## Usage

Include screenshots in markdown using:

```markdown
![Description](./screenshots/category/filename.png)
```

## Regenerate Screenshots

> **Testing:** See [Testing Guide](../developer-guide/testing.md) for full E2E test commands.

```bash
npm run screenshots:generate
npm run screenshots:extract
```

## Categories

### Main Views

| Screenshot | Description |
|------------|-------------|
| [overview](./overview.png) | Dashboard overview page with all key metrics |
| [routing](./routing.png) | Model routing configuration page |
| [requests](./requests.png) | Requests monitoring page |
| [system](./system.png) | System diagnostics and analytics page |

### Themes

| Screenshot | Description |
|------------|-------------|
| [dark-theme](./themes/dark-theme.png) | Dark theme (default) - optimized for low-light |
| [light-theme](./themes/light-theme.png) | Light theme - better for bright environments |

### Density Modes

| Screenshot | Description |
|------------|-------------|
| [compact](./density/compact.png) | Compact density - more information in less space |
| [comfortable](./density/comfortable.png) | Comfortable density - balanced spacing (default) |

### Dashboard Sections

| Screenshot | Description |
|------------|-------------|
| [health-ribbon](./sections/health-ribbon.png) | Top ribbon with key health metrics |
| [keys-heatmap](./sections/keys-heatmap.png) | Visual API key health status |
| [cost-panel](./sections/cost-panel.png) | Real-time cost tracking panel |
| [charts](./sections/charts.png) | Request rate and latency charts |

### Live Stream Panel

| Screenshot | Description |
|------------|-------------|
| [live-collapsed](./panels/live-collapsed.png) | Collapsed live stream drawer |
| [live-expanded](./panels/live-expanded.png) | Expanded live stream drawer |
| [live-content](./panels/live-content.png) | Live request content view |

### Dock Tabs

| Screenshot | Description |
|------------|-------------|
| [traces](./dock-tabs/traces.png) | Request traces table |
| [logs](./dock-tabs/logs.png) | Application logs viewer |
| [queue](./dock-tabs/queue.png) | Request queue status |
| [circuit](./dock-tabs/circuit.png) | Circuit breaker states |

### Model Routing

| Screenshot | Description |
|------------|-------------|
| [tier-builder](./routing/tier-builder.png) | Drag-and-drop tier configuration |

### Modals

| Screenshot | Description |
|------------|-------------|
| [keyboard-shortcuts](./modals/keyboard-shortcuts.png) | Keyboard shortcuts reference |

### System Page Components

| Screenshot | Description |
|------------|-------------|
| [error-breakdown](./system/error-breakdown.png) | Categorized error analysis |
| [retry-analytics](./system/retry-analytics.png) | Retry performance metrics |
| [health-score](./system/health-score.png) | Overall system health indicator |

### Progressive Disclosure

| Screenshot | Description |
|------------|-------------|
| [advanced-stats-collapsed](./progressive/advanced-stats-collapsed.png) | Collapsed advanced statistics |
| [advanced-stats-expanded](./progressive/advanced-stats-expanded.png) | Expanded lifetime stats and predictions |
| [process-health-collapsed](./progressive/process-health-collapsed.png) | Collapsed process health section |
| [process-health-expanded](./progressive/process-health-expanded.png) | Expanded system health details |

### Responsive Layouts

| Screenshot | Description |
|------------|-------------|
| [mobile-375px](./responsive/mobile-375px.png) | Mobile phone view (375px width) |
| [tablet-768px](./responsive/tablet-768px.png) | Tablet view (768px width) |
| [desktop-1920px](./responsive/desktop-1920px.png) | Desktop view (1920px width) |

### UI Components (Focused)

| Screenshot | Description |
|------------|-------------|
| [page-nav-tabs](./components/page-nav-tabs.png) | Main page navigation tabs |
| [theme-toggle](./components/theme-toggle.png) | Dark/light theme toggle button |
| [density-selector](./components/density-selector.png) | Layout density selector |
| [time-range-selector](./components/time-range-selector.png) | Chart time range picker |
| [connection-status](./components/connection-status.png) | Upstream connection indicator |
| [pause-button](./components/pause-button.png) | Proxy pause/resume control |
| [keys-heatmap](./components/keys-heatmap.png) | Focused key health visualization |
| [model-list](./components/model-list.png) | Available models list |
| [trace-table](./components/trace-table.png) | Request traces table |
| [log-entries](./components/log-entries.png) | Log entry display |
| [circuit-indicators](./components/circuit-indicators.png) | Circuit breaker state indicators |
| [request-rate-chart](./components/request-rate-chart.png) | Request rate over time |
| [latency-chart](./components/latency-chart.png) | Response latency distribution |
