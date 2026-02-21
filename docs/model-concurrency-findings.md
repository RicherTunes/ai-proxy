# Z.AI Model Concurrency & Availability Findings

**Date:** 2026-02-17/18
**Subscription:** Coding Plan
**Base URL:** https://api.z.ai/api/anthropic
**Total Keys:** 20

> **Related:** See [Z.ai Knowledge Base](../reference/zai-knowledge-base.md) for complete documentation on tiers, pricing, and API configuration.
> **Quick Reference:** See [Z.ai Coding Subscription](../reference/zai-coding-subscription.md) for tier limits and quotas.

## Key Finding: Concurrency is PER-ACCOUNT, not per-key

Multi-key tests on `glm-4.7` and `glm-4.5-air` both confirm:
- Spreading requests across multiple API keys does NOT increase throughput
- All 20 keys share the same account-level concurrency quota
- **The router's `concurrencyMultiplier` (= number of keys) is wrong and massively inflates capacity estimates**

## Model Availability

### Working Models (Coding Subscription)

| Model | Status | Observed Max Conc (1 key) | Metadata maxConc | Notes |
|-------|--------|--------------------------|-----------------|-------|
| Model | Status | Max Clean Conc | First 429 | Consistent 429 | Metadata |
|-------|--------|---------------|-----------|----------------|----------|
| `glm-4.7` | OK | **15** | 10 (sporadic) | 19 | 3 |
| `glm-4.6` | OK | **8+** | not seen up to 8 | - | 3 |
| `glm-4.5` | OK | **8+** | not seen up to 8 | - | 10 |
| `glm-4.5-air` | OK | **15** | 10 (sporadic) | 17 | 5 |
| `glm-5` | OK | 1 (not stress-tested) | - | - | 1 |
| `glm-4.5-flash` | OK | 1 (not stress-tested) | - | - | 2 |
| `glm-4.7-flash` | OK | 1 (not stress-tested) | - | - | 1 |

### BLOCKED Models (Error 1113: "Insufficient balance or no resource package")

These models return HTTP 429 with Z.AI error code `1113` at **any** concurrency level, including 1.
They are NOT available on the Coding Plan subscription and should be removed from tier routing.

| Model | Error Code | Error Message |
|-------|-----------|---------------|
| `glm-4-plus` | 1113 | Insufficient balance or no resource package |
| `glm-4.5-airx` | 1113 | Insufficient balance or no resource package |
| `glm-4.7-flashx` | 1113 | Insufficient balance or no resource package |
| `glm-4.5-x` | 1113 | Insufficient balance or no resource package |

### INVALID Models (Error 1211: "Unknown Model")

These model IDs don't exist in Z.AI's API:

| Model | Error Code | Error Message |
|-------|-----------|---------------|
| `glm-4.32b-0414-128k` | 1211 | Unknown Model, please check the model code |
| `glm-flash` | 1211 | Unknown Model, please check the model code |

## Detailed Concurrency Results

### glm-4.7 (up to 20 parallel)

```
Concurrency  1-9:   All green (0 429s)
Concurrency 10:     Round 1: 10/10 ok, Round 2: 9/10 ok (1 429) -- SOFT LIMIT
Concurrency 11-15:  Sporadic 429s (1-2 per round), but most succeed
Concurrency 16-20:  Increasing 429s (1-4 per round), still majority succeed
```

**Conclusion:** Soft limit around 10 concurrent per account. Z.AI queues rather than hard-rejects,
allowing bursts above the limit with some failures.

### glm-4.5-air (up to 12+ parallel)

```
Concurrency  1-9:   All green (0 429s)
Concurrency 10:     Round 1: 10/10 ok, Round 2: 9/10 ok (1 429) -- SOFT LIMIT
Concurrency 11-12:  All green again (0 429s)
```

**Conclusion:** Similar soft limit around 10. Occasional 429s are transient, not a hard wall.

## Impact on Proxy Configuration

### 1. Remove unavailable models from tiers

The following models must be removed from tier routing:
- `glm-4-plus` (light tier)
- `glm-4.5-airx` (medium tier)
- `glm-4.7-flashx` (light tier)
- `glm-4.5-flash` (light tier) -- free model, may have very low limits
- `glm-4.32b-0414-128k` (light tier) -- model doesn't exist

### 2. Fix concurrencyMultiplier

Since concurrency is per-account (not per-key), the effective concurrency multiplier should be 1,
not the number of API keys (20). With 20 keys, the router currently thinks each model has 20x its
actual capacity.

### 3. Update maxConcurrency values

Based on stress test results, recommended values:

| Model | Current | Recommended | Rationale |
|-------|---------|-------------|-----------|
| `glm-4.7` | 3 | 10 | Clean up to 9, soft limit at 10 |
| `glm-4.6` | 3 | 8 | Clean up to 8 (need higher testing) |
| `glm-4.5` | 10 | 10 | Confirmed ok up to 8, keep 10 |
| `glm-4.5-air` | 5 | 10 | Clean up to 9, soft limit at 10 |
| `glm-5` | 1 | 1 | Keep conservative until tested |
| `glm-4.7-flash` | 1 | 1 | Free model, keep conservative |
| `glm-4.5-flash` | 2 | 2 | Free model, keep conservative |

### 4. Distinguish error 1113 from real 429s

The proxy currently treats error 1113 (billing/subscription) the same as rate limit 429s.
Error 1113 should be classified differently:
- Don't retry (model is permanently unavailable on this subscription)
- Don't cooldown (it's not a rate limit)
- Mark model as "unavailable" and skip in routing
