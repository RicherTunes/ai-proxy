# Changelog

All notable changes to GLM Proxy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Documentation restructure with organized sections
- Automated release workflow with semantic versioning
- Release drafter for automated PR changelogs
- Commitlint for conventional commit enforcement
- Pre-commit hooks for test validation
- Version check script for version consistency

### Changed
- CI/CD improvements for automated releases

## [2.4.0] - 2026-02-13 (Operational Maturity)

### Major Milestones Completed
- **Phase 18**: Cosmetic cleanup (SSE test cleanup, dashboard optimizations)
- **Phase 17**: Test Infrastructure Fixes (model router unit tests, E2E drift detection)
- **Phase 16**: PUT Config Normalization (migration tracking, persistence)
- **Phase 15**: GLM-5 Shadow Mode Indicator (stats panel, UI integration)
- **Phase 14**: Wire Drift Detection (counter API, validation)
- **Phase 13**: Implementation gap closure (TDD Red→Green→Refactor cycles)

### Statistics
- 4,531 tests passing across 150 suites
- 98.67% statement coverage, 91.41% branch coverage
- 200+ commits since last major release
- 129 features added, 23 bugs fixed, 21 refactors completed
- 0 critical failures in CI pipeline

### Added
- Unified model selection with tier-based routing system
- D3 visualization for tier distribution analytics
- Drag-and-drop tier builder with state management
- Model router with intelligent classification and cost tracking
- Cost tracking admin API for financial monitoring
- Enhanced SSE endpoints with drift detection capabilities
- TierBuilder class with drag-and-drop interface for dynamic tier management
- KeyScheduler with drift detection and accessor methods
- Model counters endpoint for tracking and analytics
- Explain endpoint for unified trace explanations
- Model routing simulation endpoint for testing
- CSS contract tests with HTML structure ratchets
- Vendor script E2E tests for drift detection
- GLM-5 complexity upgrade support in model routing
- Configuration normalization with migration tracking
- JavaScript file splitting and skeleton loading optimization
- Dashboard module extraction (SSE, table, tier builder)
- Navigation flattening and request sub-tabs structure
- Inline style extraction and SVG icons implementation
- KPI deduplication for better performance
- Key management modules extraction (timers, buffers, async safety)
- Loading indicators for all async operations in dashboard
- Admin API enhancements for key override management

### Changed
- Dashboard CSP violations resolved and performance optimized
- SSE event consolidation (Milestone 4)
- Model routing controller extraction (14 controllers, TDD approach)
- Dashboard rate limit increased from 60 to 300 RPM
- Dashboard split into modules: SSE, table, tier builder
- CSS design tokens consolidated and modularized
- SVG icons implementation replacing older icon patterns
- Error handling robustness in model selection algorithms
- Test infrastructure with Jest configuration improvements
- EventSource lifecycle management added to all SSE tests
- CSS contract tests and HTML structure ratchets for better testing
- Layout redesign and navigation improvements
- Component architecture refactored for better separation of concerns
- Split module rendering in dashboard (SSE, table, tier builder)
- Model mapping display improved in Requests table
- Live Stream tab refresh race condition resolved

### Fixed
- Dashboard routing visualization and performance issues
- Model mapping display in Requests table when routing occurs
- Live Stream tab refresh race condition (DOM manipulation conflicts)
- Tier builder state management and navigation issues
- Cost tracking accuracy and admin API reliability
- 16 test regressions from stability/UX overhaul
- Configuration normalization edge cases and migration tracking
- Concurrency multiplier reverted to match z.ai per-account limits
- Dashboard asset loading and CSP compliance
- Startup migration skip conditions and key initialization
- Memory leaks from improper resource cleanup
- Async safety issues in timer and buffer management
- Noisy logging and performance bottlenecks
- Duplicate DOM manipulation in Live Stream tab
- Noisy route-policy logging on startup
- Configuration test issues with toConfig stats field
- Broken fetcher and unsafe parsing patterns
- Timer and buffer management issues

### Performance
- RingBuffer migration for improved memory management
- Dashboard performance optimizations with modular architecture
- Rate limiting improvements (pacing threshold, cooldown decay)
- Burst pacing implementation for 95%+ success rate
- Multi-pool model mapping efficiency improvements
- Model routing resilience improvements with 10 enhancements
- Pool cooldown configuration and SSE improvements
- Responsive layout improvements across all dashboard pages
- Coverage improvements and hardening across 6 modules
- CSS optimization with reduced redundancy

### Security
- CSP (Content Security Policy) violations resolved
- Input validation and output encoding improvements
- Secure configuration normalization
- Admin API authentication enhancements
- Error handling with sensitive data protection
- Request/response sanitization

### Documentation
- Comprehensive documentation restructure with organized sections
- API documentation for all endpoints
- Migration guides for configuration changes
- Technical debt analysis and tracking
- Phase-by-phase implementation documentation
- Testing documentation with contract tests
- Performance benchmarking documentation

## [2.3.0] - 2026-02-11 (Unified Model Selection)

### Added
- Unified model selection with tier-based routing
- D3 visualization for tier distribution
- Drag-and-drop tier builder interface
- Cost tracking admin API
- Model routing enhancements
- Controller extraction (14 controllers, TDD approach)
- Circuit breaker and rate limiting improvements
- Cluster management enhancements
- Model router with intelligent classification
- Key scheduling system
- SSE event consolidation (Milestone 4)

## [2.2.0] - 2026-01-25 (Major Refactor)

### Added
- V2 config schema with models[] support
- Modular architecture extraction
- Key scheduler v2 with explainable selection
- Enhanced cost tracking with per-model pricing
- Batch API capabilities
- Comprehensive test suite (Red→Green→Refactor)
- Legacy proxy.js decommissioning
- Single entry point architecture

## Previous Versions

See [milestones/](./docs/milestones/) for detailed historical documentation.
