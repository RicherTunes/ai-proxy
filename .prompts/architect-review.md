# AI Architect Review Prompt — GLM Proxy Codebase

Use this prompt with Claude Opus / GPT-4 / Gemini Pro to get a comprehensive architectural review and improvement plan.

---

## The Prompt

```
You are a senior software architect performing a comprehensive review of a production Node.js codebase. Your goal is to identify tech debt, scalability bottlenecks, test gaps, and hardening opportunities, then produce an actionable improvement roadmap.

## Project Overview

**ai-proxy v2.4.0** — A high-performance API proxy that sits between Claude Code clients and z.ai's GLM API. It handles model routing, rate limiting, circuit breaking, adaptive concurrency, cost tracking, and provides a real-time dashboard.

### Architecture

**Backend (Node.js, zero runtime dependencies):**
- `proxy-server.js` (6223 LOC) — HTTP server, SSE broadcasting, admin API (40+ endpoints), routing
- `request-handler.js` (2944 LOC) — Retry loop, health-aware DNS, adaptive timeouts, upstream proxy
- `model-router.js` (3761 LOC) — Tier-based model selection (heavy/medium/light), failover, cooldowns
- `key-manager.js` (1771 LOC) — 20-key round-robin, circuit breakers, rate limit tracking
- `config.js` (1229 LOC) — Environment + file config, provider registry, model mapping
- `stats-aggregator.js` (1626 LOC) — Real-time metrics, histograms, anomaly detection
- `upstream-health.js` — TCP probe health monitor with automatic endpoint failover
- `model-discovery.js` (994 LOC) — Runtime model probing against z.ai
- 44 modules total, 35K LOC backend

**Frontend (vanilla JS, no framework, no build step):**
- `data.js` (3142 LOC) — Stats fetching, chart rendering (Chart.js), cost tracking
- `init.js` (2618 LOC) — Page routing, keyboard shortcuts, responsive header, drawer
- `live-flow.js` (1209 LOC) — Runway per-request flow visualization (SSE-driven)
- `tier-builder.js` (1778 LOC) — Drag-drop tier configuration UI
- 16 modules, 12K LOC frontend, 8 CSS files (7.5K LOC)

**Tests:**
- 187 test files, 97K LOC tests, 5696 tests passing
- Jest + JSDOM for unit, Playwright for E2E
- 2 pre-existing failures (NUL byte path edge case)

### Key Design Decisions
- Zero runtime dependencies (only devDependencies for testing)
- Single-process mode with optional clustering
- Server-rendered HTML dashboard (no SPA framework, no build step)
- SSE for real-time updates (request-start, request-complete, pool-status, probe-status, upstream-health)
- Health-aware DNS with per-IP health tracking and automatic bad-IP avoidance
- Automatic endpoint failover (api.z.ai → open.bigmodel.cn) with flip-flop prevention

## What I Need You To Review

### 1. Tech Debt Identification
- Code that's grown organically and needs refactoring (proxy-server.js at 6223 LOC is a red flag)
- Duplicated logic across modules
- Hardcoded values that should be configurable
- Error handling gaps (silent catches, missing error propagation)
- Configuration complexity (config.js merges 5+ sources)

### 2. Scalability Analysis
- Can this handle 1000 req/sec? 10K? Where does it break?
- The single-process architecture — when does clustering become mandatory?
- Memory growth patterns (Maps, Sets, history buffers that grow unbounded)
- SSE broadcasting to N clients — does it scale linearly?
- The request queue (RequestQueue) — is it sufficient under sustained load?

### 3. Test Coverage Gaps
- Which modules have no test coverage?
- Which critical paths (retry loop, failover, circuit breaker state transitions) need more edge case tests?
- E2E test gaps (the dashboard has 2377 LOC of E2E but many pages aren't covered)
- Integration test gaps (does the full proxy + router + key manager chain get tested end-to-end?)
- Load/stress test gaps

### 4. Feature Hardening
- The model routing failover logic — can it cascade in unexpected ways?
- Circuit breaker state machine — are there impossible state transitions?
- Rate limit sync (observes upstream 429 headers) — can it be fooled?
- Cost tracking accuracy — does it handle retries correctly (double-counting)?
- The upstream health monitor — does it handle DNS changes, CDN failover, partial outages?

### 5. Performance Optimization
- The progress timer in live-flow.js runs at 100ms — is that too aggressive?
- Chart.js with 200+ data points — should we downsample or use canvas2d directly?
- The virtual scroll in sse.js — does it handle 10K+ requests efficiently?
- CSS containment usage — are we missing opportunities?
- The `_renderStream` method rebuilds all DOM on every SSE event — can we diff?

### 6. Security Audit
- Admin endpoints have optional auth (AdminAuth) — is the auth scheme robust?
- SSE connections are IP-tracked but not authenticated
- Request payloads are stored in memory (RequestStore) — PII exposure risk?
- The provider registry handles API keys — are they properly redacted in logs/exports?
- CORS headers on admin API — too permissive?

## Output Format

For each area, provide:
1. **Finding** — What you found
2. **Severity** — Critical / High / Medium / Low
3. **Impact** — What happens if not addressed
4. **Fix** — Specific, actionable fix with file:location
5. **Effort** — Hours estimate (S: <2h, M: 2-8h, L: 8-40h, XL: 40h+)

Then provide a **prioritized roadmap** with 4 phases:
- Phase 1: Critical fixes (do now, <1 week)
- Phase 2: Scalability prep (next 2 weeks)
- Phase 3: Test hardening (ongoing)
- Phase 4: Architecture improvements (next quarter)

Be specific. Reference actual module names and function names. Don't give abstract advice — give exact changes.
```

---

## How to Use

1. **With Claude Code**: Paste this prompt, then ask it to read the key files (`lib/proxy-server.js`, `lib/request-handler.js`, `lib/model-router.js`, `lib/config.js`) and apply the review.

2. **With Claude API / ChatGPT**: Attach the key source files as context, then paste the prompt.

3. **Iterative approach**: Start with one section (e.g., "Focus only on #2 Scalability"), get the findings, then move to the next.

4. **After getting results**: Create a GitHub issue for each Phase 1 finding, and a milestone for each phase.

---

## Context Files to Attach (priority order)

1. `lib/proxy-server.js` — The largest module, most tech debt
2. `lib/request-handler.js` — The hot path, most performance-critical
3. `lib/model-router.js` — The routing brain, most complex logic
4. `lib/key-manager.js` — Key rotation, circuit breakers
5. `lib/upstream-health.js` — New, needs validation
6. `public/js/data.js` — Frontend rendering, chart performance
7. `public/js/live-flow.js` — Runway visualization, SSE handling
8. `public/js/init.js` — Page management, keyboard shortcuts
9. `test/model-router.test.js` — Largest test file, pattern reference
