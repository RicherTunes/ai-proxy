# Design Doc: Multi-Provider Abstraction Layer

**Status:** Spike / Feasibility
**Created:** 2026-02-22
**Author:** AI-assisted (Month 5-6 roadmap)

---

## 1. Problem Statement

The proxy is tightly coupled to a single upstream provider (z.ai / Anthropic). All requests share one `targetHost`, one auth format, and one request schema. Users cannot route different models to different providers (e.g., Claude via Anthropic direct, GPT-4 via OpenAI, Gemini via Google).

## 2. Design Goals

1. **Explicit opt-in**: No request ever routes to a provider the user hasn't configured
2. **Zero-surprise cost**: Paid providers display cost warnings in dashboard
3. **Backward compatible**: Existing single-provider configs work unchanged
4. **Minimal blast radius**: Changes are additive, not restructuring

## 3. Architecture

### 3.1 Provider Registry

New file: `lib/provider-registry.js`

```
ProviderRegistry
  ├── providers: Map<name, ProviderConfig>
  │     ├── targetHost: string
  │     ├── targetBasePath: string
  │     ├── targetProtocol: 'http:' | 'https:'
  │     ├── authScheme: 'x-api-key' | 'bearer' | 'custom'
  │     ├── requestTransform: null | 'anthropic-to-openai'
  │     ├── responseTransform: null | 'openai-to-anthropic'
  │     ├── extraHeaders: Record<string, string>
  │     └── costTier: 'free' | 'metered' | 'premium'
  └── getProvider(name): ProviderConfig | null
```

### 3.2 Config Schema Extension

```json
{
  "providers": {
    "z.ai": {
      "targetHost": "api.z.ai",
      "targetBasePath": "/api/anthropic",
      "targetProtocol": "https:",
      "authScheme": "x-api-key",
      "costTier": "free"
    },
    "anthropic": {
      "targetHost": "api.anthropic.com",
      "targetBasePath": "",
      "targetProtocol": "https:",
      "authScheme": "x-api-key",
      "extraHeaders": { "anthropic-version": "2023-06-01" },
      "costTier": "metered"
    },
    "openai": {
      "targetHost": "api.openai.com",
      "targetBasePath": "/v1",
      "targetProtocol": "https:",
      "authScheme": "bearer",
      "requestTransform": "anthropic-to-openai",
      "responseTransform": "openai-to-anthropic",
      "costTier": "metered"
    }
  }
}
```

### 3.3 Model Mapping Extension

Current: `"claude-opus-4-6": "glm-4.7"` (implicit z.ai provider)

Proposed: Add optional `provider` field per model entry:

```json
{
  "modelMapping": {
    "models": {
      "claude-opus-4-6": { "target": "glm-4.7", "provider": "z.ai" },
      "gpt-4-turbo": { "target": "gpt-4-turbo", "provider": "openai" }
    }
  }
}
```

Backward compatibility: string values (e.g., `"glm-4.7"`) default to the primary provider.

### 3.4 Request Flow (Changed Parts)

```
Client Request
  │
  ├── Model Transformer (existing)
  │     └── resolves mappedModel + provider
  │
  ├── Provider Lookup (NEW)
  │     └── registry.getProvider(provider)
  │           → targetHost, targetBasePath, authScheme
  │
  ├── Auth Header Formatter (NEW)
  │     └── formatAuth(scheme, key) → { headerName, headerValue }
  │
  ├── Request Body Transform (NEW, only if provider needs it)
  │     └── e.g., anthropic-to-openai schema mapping
  │
  ├── Upstream Request (existing, parameterized)
  │     └── uses provider-specific host/path/headers
  │
  ├── Response Parse (existing — already multi-format)
  │     └── stream-parser handles Anthropic + OpenAI formats
  │
  └── RequestTrace (existing fields, now populated)
        └── trace.provider = 'z.ai', trace.mappedProvider = 'openai'
```

## 4. Safety Invariants (TDD)

These tests MUST pass before any provider routing code is written:

1. **GUARD-01**: A request with no configured providers returns the default (z.ai) target
2. **GUARD-02**: A request for a model mapped to a non-configured provider returns 400 (not silently routed)
3. **GUARD-03**: Provider registry rejects unknown provider names at config load time
4. **GUARD-04**: Cost tier is propagated to RequestTrace for dashboard visibility
5. **GUARD-05**: Keys are never sent to a provider they weren't configured for

## 5. Components Unchanged

| Component | Reason |
|-----------|--------|
| `stream-parser.js` | Already handles Anthropic + OpenAI response formats |
| `ModelRouter` | Tier-based routing is provider-agnostic |
| `RequestTrace` | Already has `provider`/`mappedProvider` fields |
| `StatsAggregator` | Records metrics by model, not by provider |
| `Dashboard SSE` | Passes through trace data including provider |

## 6. Components Requiring Changes

| Component | Change | Effort |
|-----------|--------|--------|
| `config.js` | Add `providers` config section, env var `GLM_PROVIDERS` | Small |
| `request-handler.js` | Parameterize target host/auth per-request from provider | Medium |
| `model-transformer.js` | Return provider from model mapping lookup | Small |
| `request-trace.js` | Populate provider/mappedProvider fields | Trivial |
| `key-manager.js` | Associate keys with providers | Medium |
| `dashboard.js` + `data.js` | Provider badge on request rows, cost warning | Small |

## 7. Migration Path

1. **Phase 0 (current)**: Single provider, all config is global
2. **Phase 1**: Add `providers` config section; default provider = current global config
3. **Phase 2**: Add `provider` field to model mapping entries; models without it use default
4. **Phase 3**: Parameterize request-handler to use per-request provider config
5. **Phase 4**: Add request/response transforms for non-Anthropic providers

Each phase is independently deployable and backward compatible.

## 8. Risks

- **Key leakage**: Must ensure provider A's keys are never sent to provider B
- **Cost surprise**: Must surface cost warnings before routing to metered providers
- **Response incompatibility**: OpenAI ↔ Anthropic schema differences in edge cases (tool use, vision)
- **Latency variance**: Different providers have different latency profiles; adaptive timeout needs per-provider calibration

## 9. Decision

This design doc establishes the architecture. The TDD guard tests (Section 4) are implemented alongside this document to prevent unsafe provider routing from ever being merged.

---

## 10. Appendix A — Coupling Analysis

The following coupling points were identified through deep analysis of the codebase. Any multi-provider implementation must address these points.

### config.js (Critical — 6 coupling points)

| Line(s) | Coupling | Impact |
|---------|----------|--------|
| 15-17 | `targetHost`/`targetBasePath`/`targetProtocol` as single global tuple | Must become provider-keyed map |
| 27-44 | `modelMapping.models` maps Claude→GLM without provider field | Need optional `provider` per entry |
| 57-76 | `modelRouting.tiers` defines tiers with GLM-only model arrays | Tiers need provider-aware model lists |
| ~163 | GLM-5 staged rollout feature flag | Provider-specific feature gates |
| 256-265 | Timeout tuning assumes z.ai latency profile | Per-provider timeout calibration |
| 827-832 | Single `baseUrl` from api-keys.json | Keys need provider association |

### request-handler.js (Critical — 5 coupling points)

| Line(s) | Coupling | Impact |
|---------|----------|--------|
| 262-265 | Scalar `this.targetHost`/`this.targetBasePath`/`this.targetProtocol` | Must resolve per-request from provider |
| 1633 | `targetPath = this.targetBasePath + req.url` | Path must come from provider config |
| 1861-1881 | `_makeProxyRequest` builds options with single host/auth | Must accept provider config parameter |
| 1876-1877 | Sends BOTH `x-api-key` AND `Authorization: Bearer` headers | Must use provider's authScheme only |
| 582, 1819 | Client `x-api-key` stripped then re-injected | Strip logic provider-agnostic (OK) |

### model-transformer.js (Medium — 3 coupling points)

| Line(s) | Coupling | Impact |
|---------|----------|--------|
| 37-44, 141-146 | Returns `{ body, originalModel, mappedModel, routingDecision }` — no provider | Add `provider` to return value |
| 125-128 | `stream_options` injection assumes z.ai compatibility | Gate behind provider capability |
| 113-120 | Router selectModel has no provider context | Provider influences model selection |

### model-router.js (Medium — 4 coupling points)

| Line(s) | Coupling | Impact |
|---------|----------|--------|
| - | No provider concept in tier definitions | Tiers may need provider prefix |
| 395-412 | `extractFeatures()` reads Anthropic body schema | Provider-specific body parsing |
| 425-480 | Token estimation walks Anthropic content blocks | Provider-specific token counting |
| ~2176 | Hardcoded 'glm-5' model string | Provider-specific model detection |

### key-manager.js (Medium — 4 coupling points)

| Line(s) | Coupling | Impact |
|---------|----------|--------|
| ~107 | Key format `id.secret` (z.ai specific) | Other providers use different formats |
| 116-139 | No provider field on key entries | Keys must be associated with provider |
| 41-47 | Model pools not namespaced by provider | Pool isolation per provider |
| 829-831 | Rate limit parsing reads z.ai-specific headers | Per-provider rate limit parsing |

### cost-tracker.js (Low-Medium — 3 coupling points)

| Line(s) | Coupling | Impact |
|---------|----------|--------|
| 30-63 | Flat model-name rates without provider dimension | Provider-keyed pricing tables |
| 290-311 | `getRatesByModel()` has no provider parameter | Add provider parameter |
| 448, 554 | Default model 'claude-sonnet' hardcoded | Default per provider |

### usage-monitor.js (High — must be gated)

| Line(s) | Coupling | Impact |
|---------|----------|--------|
| ~47 | Target host defaults to api.z.ai | Only valid for z.ai provider |
| 447-451 | Hardcoded endpoints: quota/limit, model-usage, tool-usage | z.ai-proprietary API |
| 947-953 | z.ai envelope format for response parsing | z.ai-specific response structure |
| ~972 | z.ai auth format for monitoring requests | Provider-specific auth |

**Recommendation:** Gate behind `provider === 'z.ai'` check. Other providers lack equivalent monitoring APIs.

### stream-parser.js (Minimal change needed)

Already handles Anthropic nested, direct, and OpenAI-compatible usage formats. Most provider-agnostic module. No changes required.

### request-trace.js (Ready for population)

| Line(s) | Coupling | Impact |
|---------|----------|--------|
| 243-244 | `provider`/`mappedProvider` fields exist but always `null` | Populate from provider resolution |
| 424-425, 445-446 | Fields included in serialization | Already wired — just needs data |

### pricing-loader.js (Low-Medium — 2 coupling points)

| Line(s) | Coupling | Impact |
|---------|----------|--------|
| default pricing | Flat model map, no provider dimension | Provider-keyed pricing |
| ~19 | z.ai pricing URL hardcoded | Per-provider pricing source |

---

## 11. Appendix B — Implementation Checklist

### 5.3: Add provider field to model mapping
- [ ] Create `lib/provider-registry.js` with ProviderRegistry class
- [ ] Add `providers` section to DEFAULT_CONFIG in `config.js`
- [ ] Support object model mapping entries: `{ target, provider }`
- [ ] Backward compat: string entries default to primary provider

### 5.4: Make target URL per-provider
- [ ] `request-handler.js:262-265` — resolve from provider registry per-request
- [ ] `request-handler.js:1633` — path from provider config
- [ ] `request-handler.js:1861-1881` — options from provider config

### 5.5: Auth header transformation per provider
- [ ] `request-handler.js:1876-1877` — use `formatAuthHeader()` from registry
- [ ] Remove dual header injection (currently sends both x-api-key AND Bearer)

### 5.6: Request body transformation layer
- [ ] `model-transformer.js:125-128` — gate `stream_options` behind provider capability
- [ ] Add Anthropic↔OpenAI body schema mapping for non-Anthropic providers
- [ ] `model-transformer.js:141-146` — add `provider` to return value

### 5.7: Dashboard provider visibility
- [ ] `request-trace.js:243-244` — populate provider/mappedProvider from resolution
- [ ] Dashboard request rows: provider badge
- [ ] Cost warning for `costTier: 'metered'` or `'premium'`

### 5.8: Claude direct passthrough spike
- [ ] Define 'anthropic' provider with zero transformations
- [ ] Route claude-* models to anthropic provider when configured
- [ ] Verify auth (x-api-key only), headers (anthropic-version), and body pass unchanged
