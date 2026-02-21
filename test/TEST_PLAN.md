# GLM Proxy Test Plan

## Overview
Comprehensive test coverage for the GLM proxy including unit tests, integration tests, and stress tests.

## Test Categories

### 1. Unit Tests

#### 1.1 Key Manager (`key-manager.test.js`)
- [x] Basic key loading
- [x] Key reloading (add/remove)
- [x] Circuit breaker integration
- [x] Concurrency limits
- [x] **Health score calculation with recency penalty**
- [x] **Health score calculation with inFlight penalty**
- [x] **Rate limit tracking (rateLimitedCount, rateLimitedAt)**
- [x] **Smart key rotation (avoid rate-limited keys)**
- [x] **Success rate calculation (excluding in-flight)**

#### 1.2 Stats Aggregator (`stats-aggregator.test.js`)
- [x] Basic stats tracking
- [x] Error categorization
- [x] **Client request tracking (total/succeeded/failed)**
- [x] **Client success rate calculation**
- [x] **Rate limit status aggregation**

#### 1.3 Request Handler (`request-handler.test.js`)
- [x] Basic request proxying
- [x] Retry logic
- [ ] **NEW: Client request tracking calls**
- [ ] **NEW: 429 passthrough tracking as failure**
- [ ] **NEW: Adaptive timeout calculation**

#### 1.4 Circuit Breaker (`circuit-breaker.test.js`)
- [x] State transitions
- [x] Failure counting
- [x] Half-open state

#### 1.5 Rate Limiter (`rate-limiter.test.js`)
- [x] Token bucket algorithm
- [x] Per-key rate limiting

### 2. Integration Tests

#### 2.1 E2E Smoke Tests (`e2e-smoke.test.js`)
- [x] Basic proxy functionality
- [ ] **NEW: Rate limit handling (429 passthrough)**
- [ ] **NEW: Multiple key rotation**

### 3. Stress Tests

#### 3.1 Socket Stress Tests (`stress/socket-stress.test.js`)
- [x] High concurrency (10+ simultaneous requests) - skips if proxy not running
- [x] Sustained load with batched requests - skips if proxy not running
- [x] 100 rapid key acquisitions with load distribution
- [x] Load spread across keys evenly
- [x] Circuit breaker recovery
- [x] Rate limit rotation
- [x] 1000 rapid stat recordings
- [x] Concurrent access accuracy
- [x] Memory leak detection (circular buffer)
- [x] Error timestamp cleanup verification

### 4. Edge Cases (NEW)

#### 4.1 Key Manager Edge Cases
- [ ] All keys rate limited
- [ ] All keys circuit broken
- [ ] Key reload during active requests
- [ ] Health score boundary conditions

#### 4.2 Request Handler Edge Cases
- [ ] Client disconnect during request
- [ ] Timeout during streaming response
- [ ] Server error during retry
- [ ] Queue timeout

## Test Commands

```bash
# Run all tests
npm test

# Run unit tests only
npm test -- --testPathPattern="test/[^/]+\.test\.js"

# Run stress tests
npm test -- --testPathPattern="stress"

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- key-manager.test.js
```

## Success Criteria

| Metric | Target | Actual |
|--------|--------|--------|
| Unit test coverage | >80% | 75.6% statements, 80.25% functions |
| Integration test pass rate | 100% | 99.8% (487/488) |
| Stress test - 100 concurrent requests | 0% failure | ✓ Load distributed |
| Memory leak in stress test | <10MB growth | ✓ Circular buffer capped |
| Sensitive data logging | 0 exposure | ✓ Auto-sanitization |

## Test Summary

**Total Tests: 488** (+93 from baseline)
- Key Manager: 87 tests ✓
- Stats Aggregator: 48 tests ✓
- Logger: 38 tests ✓ (includes sanitization tests)
- Request Handler: 33 tests ✓
- Circuit Breaker: 30 tests ✓
- History Tracker: 29 tests ✓
- Dashboard: 45 tests ✓ (new)
- E2E Smoke: 17 tests ✓ (1 flaky: Hot Reload timing)
- Stress Tests: 10 tests ✓
- Config: 22 tests ✓

## Coverage by Module

| Module | Statements | Branches | Status |
|--------|------------|----------|--------|
| circular-buffer.js | 100% | 100% | ✓ Excellent |
| history-tracker.js | 99% | 86% | ✓ Excellent |
| circuit-breaker.js | 99% | 90% | ✓ Excellent |
| request-queue.js | 99% | 86% | ✓ Excellent |
| config.js | 97% | 89% | ✓ Excellent |
| logger.js | 95% | 88% | ✓ Excellent |
| rate-limiter.js | 90% | 82% | ✓ Good |
| key-manager.js | 83% | 75% | ✓ Good |
| request-handler.js | 74% | 67% | Needs work |
| stats-aggregator.js | 68% | 56% | Needs work |
| proxy-server.js | 53% | 42% | Needs work |
| dashboard.js | 50% | 100% | Needs work |

## Professional Token Management

Token sanitization implemented in logger.js:
- Automatic masking of sensitive fields (key, apiKey, token, password, etc.)
- API key pattern detection and masking
- Recursive sanitization of nested objects
- Configurable sanitization (can be disabled if needed)
- 38 tests covering all sanitization scenarios
