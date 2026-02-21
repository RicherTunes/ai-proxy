# Coverage Debt Tracker

Files excluded from coverage thresholds with exit plans.

**Policy:** Excluded files must have a test plan and deadline. Track progress weekly.

---

## Files Excluded from Coverage

| File | Current Coverage | Target | Deadline | Status |
|------|------------------|--------|----------|--------|
| proxy-server.js | 36% | 70% | 2026-03-15 | :yellow_circle: Partial tests |
| tray-icons.js | 0% | N/A | N/A | :white_circle: Optional (UI) |

### Resolved Items

| File | Coverage | Resolution |
|------|----------|------------|
| request-handler.js | 99.16% stmts / 87.67% branches | Complete — 90+ tests across `request-handler-proxy`, `request-handler-extended`, `request-handler-branches` |
| stats-aggregator.js | 99.13% stmts / 90.62% branches | Complete — 53 tests in `test/stats-aggregator-extended.test.js` |
| key-manager.js | 97.72% stmts / 89.11% branches | Complete — 44 tests in `test/key-manager-extended.test.js` |
| request-store.js | 98.52% stmts / 93.44% branches | Complete — re-enabled in coverage, extended tests added |
| atomic-write.js | 100% stmts / 94.44% branches | Complete — extended tests for error paths and sync fallback |
| escape-html.js | 100% all | Complete — 3 tests added for `escapeHtmlViaDOM` |
| circuit-breaker.js | 100% stmts / 95.78% branches | Complete — 35 extended tests in `test/circuit-breaker-extended.test.js` |
| admin-auth.js | 100% stmts / 97.95% branches | Complete — extended tests in `test/admin-auth-extended.test.js` |
| logger.js | 100% all | Complete — extended tests in `test/logger-extended.test.js` |
| body-parser.js | 100% all | Complete — extended tests in `test/body-parser-extended.test.js` |
| ring-buffer.js | 100% all | Complete — comprehensive tests in `test/ring-buffer.test.js` |
| rate-limiter.js | 100% stmts / 95.23% branches | Complete — extended tests in `test/rate-limiter-extended.test.js` |
| model-router.js | 99.01% stmts / 93.05% branches | Complete — extended tests in `test/model-router-extended.test.js` |
| webhook-manager.js | 100% stmts / 92.04% branches | Complete — extended tests in `test/webhook-manager-extended.test.js` |
| config.js | 100% stmts / 95.76% branches | Complete — extended tests in `test/config-extended.test.js` |
| plugin-manager.js | 99.47% stmts / 94.56% branches | Complete — extended tests in `test/plugin-manager-extended.test.js` |
| route-policy.js | 98.25% stmts / 94.95% branches | Complete — extended tests in `test/route-policy-extended.test.js` |
| replay-queue.js | 99.38% stmts / 96.26% branches | Complete — extended tests in `test/replay-queue-extended.test.js` |
| redact.js | 97.08% stmts / 94.25% branches | Complete — extended tests in `test/redact-extended.test.js` |
| predictive-scaler.js | 95.13% stmts / 85.09% branches | Complete — extended tests in `test/predictive-scaler-extended.test.js` |

---

## Exit Plans

### proxy-server.js (P1 - Core)
**Current:** Basic lifecycle tests exist. 36% coverage.
**Plan:**
1. Add SSE endpoint tests
2. Add rate limiting tests
3. Add security header tests
4. Test graceful shutdown (fix timing issue)

---

## Coverage Goals

| Milestone | Files to Cover | Target Date |
|-----------|----------------|-------------|
| Q3 | proxy-server.js | 2026-03-15 |

---

## Current Global Coverage

**98.81% statements | 91.78% branches | 99.23% functions | 99.44% lines**

Target thresholds:
- Statements: 82%
- Branches: 78%
- Functions: 85%
- Lines: 82%

Only 2 files remain excluded: `proxy-server.js` (P1) and `tray-icons.js` (optional UI).

Last measured: 2026-02-08
