---
layout: default
title: Release Process
---

# Release Process

This document describes the automated and manual release processes for ai-proxy.

> **Related:**
> - [Testing Guide](./developer-guide/testing.md) - Test coverage and CI requirements
> - [Load Testing Guide](./operations/load-testing.md) - Performance baseline validation
> - [Security Configuration](./operations/security.md) - Release security checklist

## Automated Releases

Releases are automated using [semantic-release](https://github.com/semantic-release/semantic-release).

### How It Works

1. Push commits to `master` branch
2. CI runs tests and validates
3. semantic-release analyzes commit messages
4. If release needed: creates tag, updates CHANGELOG, publishes to npm

### Commit Convention

Releases follow [Conventional Commits](https://www.conventionalcommits.org/):

| Type | Bump | Description |
|------|------|-------------|
| `feat:` | minor | New feature |
| `fix:` | patch | Bug fix |
| `perf:` | patch | Performance improvement |
| `refactor:` | patch | Code refactoring |
| `docs:` | none | Documentation only |
| `test:` | none | Test only |
| `chore:` | none | Maintenance |
| `ci:` | none | CI changes |

Examples:

- `feat(dashboard): add tier builder visualization`
- `fix(api): resolve race condition in key scheduler`
- `perf(proxy): optimize circuit breaker state machine`

### Breaking Changes

Add `!` after type and `BREAKING CHANGE:` in body:

```
feat(api)!: remove legacy endpoint

BREAKING CHANGE: The /v1/legacy endpoint is removed
```

## Manual Releases

For situations where automated releases don't fit:

```bash
# Bump patch version (bug fixes)
npm run release patch

# Bump minor version (features)
npm run release minor

# Bump major version (breaking changes)
npm run release major

# Push tag to trigger release
git push origin v<version>
```

## Release Checklist

> **Pre-release Testing:** Run [Load Testing](./operations/load-testing.md) baselines and [Test Suite](./developer-guide/testing.md) before releasing.

Before a release:

- [ ] All tests passing
- [ ] Coverage thresholds met
- [ ] CHANGELOG.md updated
- [ ] Version in sync

After release:

- [ ] Verify GitHub release created
- [ ] Verify npm package published
- [ ] Update announcements
