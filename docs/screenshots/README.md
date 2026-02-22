---
layout: default
title: Dashboard Screenshots
---

# Dashboard Screenshots

This directory contains screenshots generated from E2E tests for documentation purposes.

> **Related:**
> - [Testing Guide](../developer-guide/testing.md#e2e-testing-with-screenshots) - E2E test and screenshot generation
> - [Dashboard Guide](../user-guide/dashboard.md) - Dashboard feature documentation
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

- [overview](./overview.png)
- [routing](./routing.png)
- [requests](./requests.png)
- [system](./system.png)

### Themes

- [dark-theme](./themes/dark-theme.png)
- [light-theme](./themes/light-theme.png)

### Density

- [compact](./density/compact.png)
- [comfortable](./density/comfortable.png)

### Dashboard Sections

- [health-ribbon](./sections/health-ribbon.png)
- [keys-heatmap](./sections/keys-heatmap.png)
- [cost-panel](./sections/cost-panel.png)
- [charts](./sections/charts.png)

### Live Stream Panel

- [live-collapsed](./panels/live-collapsed.png)
- [live-expanded](./panels/live-expanded.png)
- [live-content](./panels/live-content.png)

### Dock Tabs

- [traces](./dock-tabs/traces.png)
- [logs](./dock-tabs/logs.png)
- [queue](./dock-tabs/queue.png)
- [circuit](./dock-tabs/circuit.png)

### Model Routing

- [tier-builder](./routing/tier-builder.png)

### Modals

- [keyboard-shortcuts](./modals/keyboard-shortcuts.png)

### System Page

- [error-breakdown](./system/error-breakdown.png)
- [retry-analytics](./system/retry-analytics.png)
- [health-score](./system/health-score.png)

### Progressive Disclosure

- [advanced-stats-collapsed](./progressive/advanced-stats-collapsed.png)
- [advanced-stats-expanded](./progressive/advanced-stats-expanded.png)
- [process-health-collapsed](./progressive/process-health-collapsed.png)
- [process-health-expanded](./progressive/process-health-expanded.png)

### Responsive Layouts

- [mobile-375px](./responsive/mobile-375px.png)
- [tablet-768px](./responsive/tablet-768px.png)
- [desktop-1920px](./responsive/desktop-1920px.png)

### UI Components (Focused)

- [page-nav-tabs](./components/page-nav-tabs.png)
- [theme-toggle](./components/theme-toggle.png)
- [density-selector](./components/density-selector.png)
- [time-range-selector](./components/time-range-selector.png)
- [connection-status](./components/connection-status.png)
- [pause-button](./components/pause-button.png)
- [keys-heatmap](./components/keys-heatmap.png)
- [key-cell-healthy](./components/key-cell-healthy.png)
- [key-cell-warning](./components/key-cell-warning.png)
- [model-card](./components/model-card.png)
- [model-list](./components/model-list.png)
- [trace-table](./components/trace-table.png)
- [log-entries](./components/log-entries.png)
- [circuit-indicators](./components/circuit-indicators.png)
- [request-rate-chart](./components/request-rate-chart.png)
- [latency-chart](./components/latency-chart.png)
