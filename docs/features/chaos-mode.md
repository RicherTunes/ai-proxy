---
layout: default
title: Chaos Mode: Cross-Model Concurrent Throughput Maximization
---

# Chaos Mode: Cross-Model Concurrent Throughput Maximization

## Dashboard Visualization

The Model Routing page shows available models and their configurations:

![Model Routing Page](../screenshots/routing.png)

**Model List** - View all available models with their tier classifications:

![Model List](../screenshots/components/model-list.png)

## Problem Statement

With z.ai's per-model concurrency limits, a single model bottlenecks at its limit (e.g., glm-4.7 at 3 concurrent). When running parallel Claude Code agents (oh-my-claudecode's ultrawork/swarm modes), requests queue behind the same model's rate limit even though other models have spare capacity.

**Chaos mode** distributes requests across ALL available GLM models to maximize aggregate concurrent throughput, treating the entire z.ai model catalog as a single pool rather than routing everything to one model per tier.

## Rate Limit Reference (z.ai Subscription)

| Model | Concurrent | Tier | Cost (in/out per 1M) |
|-------|-----------|------|---------------------|
| glm-4.7 | 3 | HEAVY | $0.60 / $2.20 |
| glm-4.6 | 3 | HEAVY | $0.60 / $2.20 |
| glm-4.5-x | 2 | HEAVY | $2.20 / $8.90 |
| glm-4.5 | 10 | MEDIUM | $0.60 / $2.20 |
| glm-4.5-air | 5 | MEDIUM | $0.20 / $1.10 |
| glm-4.7-flashx | 3 | LIGHT | $0.07 / $0.40 |
| glm-4.7-flash | 1 | LIGHT | FREE |
| glm-4.5-flash | 1 | LIGHT | FREE |

**Max aggregate concurrency:** 28 simultaneous requests (all models combined)

## Design Principles

1. **Opt-in** — Chaos mode is a config flag, default off. Existing behavior unchanged.
2. **Quality floor** — Users set a minimum tier. Chaos never routes Opus requests to flash models.
3. **Concurrency-aware** — Prefer models with available capacity, not just round-robin.
4. **Existing infrastructure** — Build on `ModelRouter`, `KeyManager._modelPools`, and per-model cooldown tracking.
5. **Observable** — Dashboard shows which models are active, per-model utilization, chaos mode status.

## Architecture

### Config Shape

```javascript
// In config.modelRouting:
chaosMode: {
    enabled: false,

    // Minimum quality floor per incoming tier
    // Controls which models are eligible for each request type
    qualityFloor: {
        heavy: 'HEAVY',     // Opus requests → only HEAVY models (4.7, 4.6, 4.5-x)
        medium: 'MEDIUM',   // Sonnet requests → HEAVY + MEDIUM models
        light: 'LIGHT'      // Haiku requests → all models including flash
    },

    // Strategy for selecting next model from eligible pool
    strategy: 'least-loaded',  // 'least-loaded' | 'round-robin' | 'weighted-random'

    // Models explicitly excluded from chaos rotation
    excludeModels: [],    // e.g., ['glm-4.5-x'] to avoid expensive model

    // Cost guard: max $/request before downgrading model selection
    maxCostPerRequest: null,  // null = no limit, e.g., 0.05

    // Whether to include free-tier models (may have lower quality)
    includeFreeModels: true,

    // Sticky sessions: keep same model for multi-turn conversations
    stickyConversations: false
}
```

### Model Pool Manager (new class)

```
File: lib/chaos-pool.js

class ChaosPool {
    constructor(config, modelDiscovery) {
        this.models = [];           // Available models with metadata
        this.inFlight = new Map();  // model -> current in-flight count
        this.roundRobinIndex = 0;
        this.totalDispatched = 0;
    }

    // Core method: pick next model for a request
    selectModel(requestTier, attemptedModels) → { model, reason }

    // Track model usage
    acquire(model) → void
    release(model) → void

    // Get pool status for dashboard
    getStatus() → { models: [...], totalCapacity, usedCapacity }
}
```

### Selection Strategies

#### 1. `least-loaded` (recommended default)

Picks the model with the most available capacity relative to its limit.

```
score(model) = (maxConcurrency - inFlight) / maxConcurrency
```

Ties broken by: lower cost → higher maxConcurrency → round-robin.

**Example with 5 parallel requests:**

```
Request 1 → glm-4.5 (10 slots, 0 used, score=1.0)
Request 2 → glm-4.5 (10 slots, 1 used, score=0.9)
Request 3 → glm-4.5-air (5 slots, 0 used, score=1.0)  ← tied, lower cost wins
Request 4 → glm-4.5 (10 slots, 2 used, score=0.8)
Request 5 → glm-4.7 (3 slots, 0 used, score=1.0)       ← if tier allows
```

#### 2. `round-robin`

Strict rotation through eligible models. Simple, predictable. Ignores current load.

```
models = [glm-4.5, glm-4.5-air, glm-4.7, glm-4.6, ...]
Request N → models[N % models.length]
Skip if at capacity → next model
```

#### 3. `weighted-random`

Probabilistic selection weighted by available capacity.

```
weight(model) = max(0, maxConcurrency - inFlight)
P(model) = weight(model) / sum(all weights)
```

### Integration Points

#### 1. ModelRouter.selectModel() (modify)

```javascript
// In lib/model-router.js, _selectModelInternal():

if (this.config.chaosMode?.enabled) {
    return this.chaosPool.selectModel(
        classifiedTier,      // from existing classifier
        attemptedModels,     // from retry loop
        { requestModel, parsedBody }
    );
}

// ... existing tier-based logic (unchanged when chaos disabled)
```

#### 2. RequestHandler retry loop (no changes needed)

The existing `attemptedModels` Set and `modelSwitchCount` already handle the case where a model fails — chaos pool respects both via its `selectModel(requestTier, attemptedModels)` signature.

#### 3. KeyManager._modelPools (read-only integration)

ChaosPool reads `_modelPools` for real-time cooldown state but doesn't modify it. Existing pool cooldown, burst dampening, and account-level detection continue working.

```javascript
// ChaosPool checks before selecting:
const cooldownMs = keyManager.getModelPoolCooldown(model);
if (cooldownMs > 0) skip;  // Model is cooling down from 429
```

#### 4. StatsAggregator (enhance)

Add chaos mode metrics:

```javascript
chaosStats: {
    enabled: true,
    strategy: 'least-loaded',
    modelDistribution: {
        'glm-4.7': { dispatched: 15, inFlight: 2, capacity: 3 },
        'glm-4.5': { dispatched: 45, inFlight: 8, capacity: 10 },
        // ...
    },
    totalCapacity: 28,
    currentUtilization: 0.71,   // 20/28
    avgQueueWait: 42            // ms
}
```

#### 5. Dashboard (new panel section)

In the routing page, show chaos mode status:

![Model Routing Page](../screenshots/routing.png)

```
┌─ Chaos Mode ─────────────────────────────────────┐
│ Strategy: least-loaded    Utilization: 71% (20/28)│
│                                                    │
│ Model          In-Flight  Capacity  Cooldown       │
│ glm-4.7        ██░        2/3       -              │
│ glm-4.6        █░░        1/3       -              │
│ glm-4.5        ████████░░ 8/10      -              │
│ glm-4.5-air    ███░░      3/5       -              │
│ glm-4.7-flashx ██░        2/3       -              │
│ glm-4.7-flash  █          1/1       -              │
│ glm-4.5-flash  ░          0/1       429 (3.2s)     │
└────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: ChaosPool Core (lib/chaos-pool.js)

**New file.** ~150 lines.

| Task | Description |
|------|-------------|
| 1.1 | Create `ChaosPool` class with constructor accepting model list + config |
| 1.2 | Implement `getEligibleModels(requestTier, qualityFloor)` — filter by tier + exclusions |
| 1.3 | Implement `selectModel()` with least-loaded strategy |
| 1.4 | Implement round-robin and weighted-random strategies |
| 1.5 | Implement `acquire(model)` / `release(model)` for in-flight tracking |
| 1.6 | Implement `getStatus()` for dashboard consumption |
| 1.7 | Add cooldown integration: accept `getCooldown(model)` callback |

**Tests:** `test/chaos-pool.test.js` (~25 tests)

- Eligible model filtering by tier/quality floor
- Each strategy distributes correctly
- At-capacity models skipped
- Cooldown models skipped
- `excludeModels` respected
- `includeFreeModels: false` excludes free models
- `acquire`/`release` tracking
- All models at capacity → returns null (backpressure signal)

### Phase 2: ModelRouter Integration

**Modify:** `lib/model-router.js` (~30 lines)

| Task | Description |
|------|-------------|
| 2.1 | Import `ChaosPool` and instantiate in constructor when config.chaosMode.enabled |
| 2.2 | Add chaos mode branch in `_selectModelInternal()` — early return from ChaosPool |
| 2.3 | Pass `attemptedModels` to ChaosPool.selectModel() |
| 2.4 | Wire `acquire`/`release` calls — acquire on model selection, release when request completes |
| 2.5 | Add `getChaosStatus()` method for API endpoint |

**Tests:** Add to `test/model-router.test.js` (~10 tests)

- Chaos mode bypasses classifier
- Quality floor enforced
- Attempted models excluded
- Disabled chaos mode → existing behavior unchanged

### Phase 3: Config + API

**Modify:** `lib/config.js` (~15 lines)

| Task | Description |
|------|-------------|
| 3.1 | Add `chaosMode` defaults to `DEFAULT_CONFIG.modelRouting` |
| 3.2 | Add chaos mode toggle to PUT `/model-routing` API |
| 3.3 | Add GET `/model-routing/chaos` status endpoint in proxy-server.js |

**Tests:** Add to `test/config.test.js` (~5 tests)

### Phase 4: RequestHandler Release Hook

**Modify:** `lib/request/request-handler.js` (~10 lines)

| Task | Description |
|------|-------------|
| 4.1 | After request completes (success or final failure), call `modelRouter.releaseChaosModel(model)` |
| 4.2 | Ensure release happens in `finally` block — never leak in-flight count |

### Phase 5: Stats + Dashboard

**Modify:** `lib/stats-aggregator.js` (~20 lines), `public/dashboard.js` (~80 lines)

| Task | Description |
|------|-------------|
| 5.1 | Add `chaosStats` to stats aggregator export |
| 5.2 | Add chaos mode section to routing page in dashboard |
| 5.3 | Add per-model utilization bars with real-time updates |
| 5.4 | Add chaos mode toggle button in admin controls |

### Phase 6: E2E Tests

**New file:** `test/e2e/chaos-mode.e2e.spec.js` (~10 tests)

| Test | Description |
|------|-------------|
| Enable/disable via API | PUT /model-routing with chaosMode.enabled toggle |
| Dashboard shows chaos panel | Visual verification of chaos mode UI |
| Multiple concurrent requests | Verify distribution across models |
| Quality floor enforcement | Heavy request never routes to LIGHT model |
| Cooldown model skipped | Mock 429 → verify model rotation |

## File Change Summary

| File | Action | Lines |
|------|--------|-------|
| `lib/chaos-pool.js` | **New** | ~150 |
| `test/chaos-pool.test.js` | **New** | ~250 |
| `lib/model-router.js` | Modify | ~30 |
| `lib/config.js` | Modify | ~15 |
| `lib/request/request-handler.js` | Modify | ~10 |
| `lib/stats-aggregator.js` | Modify | ~20 |
| `lib/proxy-server.js` | Modify | ~15 |
| `public/dashboard.js` | Modify | ~80 |
| `test/model-router.test.js` | Modify | ~50 |
| `test/config.test.js` | Modify | ~20 |
| `test/e2e/chaos-mode.e2e.spec.js` | **New** | ~150 |

**Total:** ~3 new files, ~8 modified files, ~790 lines

## Execution Order

```
Phase 1 (ChaosPool + tests) → Phase 2 (ModelRouter) → Phase 3 (Config/API)
                                                              ↓
                               Phase 4 (RequestHandler) → Phase 5 (Dashboard)
                                                              ↓
                                                        Phase 6 (E2E)
```

Phases 1-3 are the critical path. Phase 4 is small. Phase 5 is cosmetic. Phase 6 validates everything.

## Quality Floor Matrix

Shows which models are eligible for each incoming request tier:

| Incoming Tier | Quality Floor | Eligible Models | Max Aggregate Concurrency |
|---------------|---------------|-----------------|---------------------------|
| heavy | HEAVY | glm-4.7 (3), glm-4.6 (3), glm-4.5-x (2) | **8** |
| medium | MEDIUM | Above + glm-4.5 (10), glm-4.5-air (5) | **23** |
| light | LIGHT | Above + flashx (3), flash (1), 4.5-flash (1) | **28** |

This means:

- **Opus** requests spread across 3 heavy models (8 concurrent max)
- **Sonnet** requests spread across 5 models (23 concurrent max)
- **Haiku** requests can use everything (28 concurrent max)

## Sticky Conversations (Future Enhancement)

When `stickyConversations: true`, requests with the same conversation context (detected via system prompt hash or conversation ID header) stick to the same model. This avoids inconsistent behavior from model-switching mid-conversation.

Implementation: LRU map of `conversationHash → model`, with TTL expiry.

## Rollback Safety

- Chaos mode is behind a config flag — disable by setting `chaosMode.enabled: false`
- No changes to existing routing logic when disabled
- ChaosPool is a new class — no existing code modified when not instantiated
- Quality floor prevents quality degradation by default
- All existing tests must continue passing with chaos mode disabled
