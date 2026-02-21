# Migration Tracking

This file tracks the extraction of god class modules using the Strangler Pattern.

## Legend
- ✅ Extracted - Module successfully extracted and integrated
- 🔄 In Progress - Currently being worked on
- 📋 Planned - Scheduled for extraction
- ⚠️ Blocked - Cannot proceed due to dependency

## Extractions

| Old Symbol | New Module | Status | PR | Notes |
|------------|------------|--------|-----|-------|
| `_categorizeError()` (internal) | `lib/request/error-classifier.js` | ✅ Extracted | - | Pure function, 10+ error types |
| `parseTokenUsage()` (internal) | `lib/request/stream-parser.js` | ✅ Extracted | - | Streaming response token parsing |
| `_transformRequestBody()` (internal) | `lib/request/model-transformer.js` | ✅ Extracted | - | Model mapping and routing logic |
| `_proxyWithRetries()` (interface) | `lib/request/retry-engine.js` | ✅ Interface Created | - | Interface wrapper, full extraction deferred |
| `_modelPools` state management | `lib/key-management/pool-manager.js` | ✅ Extracted | - | Per-model pool isolation, cooldown management |
| `acquireKey()` interface | `lib/key-management/key-selector.js` | ✅ Interface Created | - | Key selection interface, full extraction deferred |
| `StatsAggregator.load/save/flush` | `lib/stats/persistence.js` | ✅ Extracted | - | File I/O for stats storage |
| `StatsAggregator.tokens tracking` | `lib/stats/token-tracker.js` | ✅ Extracted | - | Token usage tracking per key |
| `StatsAggregator.errors tracking` | `lib/stats/error-tracker.js` | ✅ Extracted | - | Error categorization and tracking |
| `ProxyServer switch statement` | `lib/proxy/router.js` | ✅ Extracted | - | Route registration and dispatch |
| `ProxyServer model routes` | `lib/proxy/controllers/model-controller.js` | ✅ Extracted | - | Model routing, models, model-selection, model-mapping endpoints |
| `ProxyServer auth routes` | `lib/proxy/controllers/auth-controller.js` | ✅ Extracted | - | Auth status, requireAuth, isAdminRoute, requiresAdminAuth |
| `ProxyServer._handleHealth()` | `lib/proxy/controllers/health-controller.js` | ✅ Extracted | - | Health check endpoints with component checks |
| `ProxyServer stats routes` | `lib/proxy/controllers/stats-controller.js` | ✅ Extracted | - | /stats, /metrics, /persistent-stats, /reload, /backpressure, /stats/tenants |
| `ProxyServer logs routes` | `lib/proxy/controllers/logs-controller.js` | ✅ Extracted | - | /logs, /audit-log, /control/clear-logs |
| `ProxyServer._handleHistory()` | `lib/proxy/controllers/history-controller.js` | ✅ Extracted | - | /history endpoint with minutes parameter |
| `ProxyServer webhook routes` | `lib/proxy/controllers/webhook-controller.js` | ✅ Extracted | - | /webhooks, /webhooks/test endpoints |
| `ProxyServer trace routes` | `lib/proxy/controllers/trace-controller.js` | ✅ Extracted | - | /traces, /traces/:id with filtering |
| `ProxyServer tenant routes` | `lib/proxy/controllers/tenant-controller.js` | ✅ Extracted | - | /tenants, /tenants/:id/stats |
| `ProxyServer keys routes` | `lib/proxy/controllers/keys-controller.js` | ✅ Extracted | - | /debug/keys, /stats/latency-histogram/:id |
| `ProxyServer predictions route` | `lib/proxy/controllers/predictions-controller.js` | ✅ Extracted | - | /predictions with key predictions |
| `ProxyServer requests routes` | `lib/proxy/controllers/requests-controller.js` | ✅ Extracted | - | /requests, /requests/search, /requests/:id |
| `ProxyServer compare route` | `lib/proxy/controllers/compare-controller.js` | ✅ Extracted | - | /compare for key comparison |

## Already Done (Before This Plan)

| Old Symbol | New Module | Status | Notes |
|------------|------------|--------|-------|
| Dashboard CSS/JS | `public/dashboard.css`, `public/dashboard.js` | ✅ Extracted | Externalized as static assets |
| KeyScheduler | `lib/key-scheduler.js` | ✅ Extracted | Scheduling logic extracted from key-manager |
| 35+ utility modules | Various in `lib/` | ✅ Modularized | circuit-breaker, rate-limiter, logger, etc. |

## Remaining God Classes

| File | Lines | Status | Target Modules |
|------|-------|--------|----------------|
| `proxy-server.js` | 4,973 | 📋 Planned | Router + controllers (Week 3-4) |
| `request-handler.js` | 1,836 | ✅ Done | error-classifier, stream-parser, model-transformer, retry-engine (Week 1 complete) |
| `key-manager.js` | 1,359 | ✅ Done | pool-manager, key-selector (Week 2 complete) |
| `stats-aggregator.js` | 1,310 | 🔄 In Progress | persistence ✅, token-tracker ✅, error-tracker ✅ (Week 5 - ready for integration) |
| `dashboard.js` | 1,523 | ✅ Done | CSS/JS already externalized |

## Module System

**CommonJS Only** - All extractions MUST use `require` / `module.exports`.
Converting to ESM (`export` / `import`) is a separate project.

## PR Checklist

Every extraction PR must include:

```
## "No Behavior Changes" Verification

- [ ] Diff is mostly `git mv` + require rewires
- [ ] No logic changes in moved code
- [ ] All existing tests pass
- [ ] Contract tests for this module pass
- [ ] MIGRATION.md updated with new entry

If you changed behavior: this PR must be labeled "behavior-change" and split from the "move" PR.
```

## References

- See [God Class Refactoring Plan](./docs/REFACTORING_PLAN.md) for detailed execution strategy
- Week 1: RequestHandler Pure Module Extraction
- Week 2: KeyManager Pool/Model Separation
- Week 3: ProxyServer Router Registry + Model Controller
- Week 4: ProxyServer Auth + Health Controllers
- Week 5: StatsAggregator Split
