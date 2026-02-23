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
