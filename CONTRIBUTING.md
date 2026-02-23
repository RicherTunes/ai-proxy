# Contributing to AI Proxy

Thank you for your interest in contributing!

## Development Setup

1. Fork and clone the repository
2. Run `npm install`
3. Copy `api-keys.json.example` to `api-keys.json` and add test keys
4. Run `npm test` to verify setup

## Running Tests

- `npm test` - Unit tests with coverage
- `npm run test:e2e` - Playwright E2E tests
- `npm run test:stress` - Stress tests
- `npm run test:all` - All test suites

## Code Style

- Use 2-space indentation
- Prefer CommonJS (not ESM) - this project uses `require()`
- Write tests for new features
- Keep modules focused - prefer smaller files over large ones
- Add JSDoc comments for public APIs

## Commit Messages

Follow conventional commits:

- `feat:` - New feature
- `fix:` - Bug fix
- `refactor:` - Code change without functional change
- `test:` - Adding or updating tests
- `docs:` - Documentation changes

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with tests
3. Ensure all tests pass
4. Submit a PR with description
5. Respond to review feedback

## Visual / Screenshot Testing

The project uses Playwright snapshot tests for dashboard documentation screenshots.

### How It Works

- `npm run screenshots:generate` — Regenerates baseline snapshots (uses `--update-snapshots`)
- `npm run screenshots:extract` — Extracts screenshots to `docs/screenshots/`
- CI runs `--ignore-snapshots` to avoid accidental snapshot updates

### Updating Snapshots

When UI changes affect screenshots:

1. Run `npm run screenshots:generate` locally
2. Review the updated images in `test/e2e/` snapshot directories
3. Run `npm run screenshots:extract` to copy to docs
4. Commit both the snapshot updates and extracted docs screenshots

### Playwright Version

The Playwright version is pinned exactly in `package.json` to prevent CI drift. When upgrading:

1. Update the version in `package.json`
2. Run `npx playwright install --with-deps chromium`
3. Regenerate snapshots: `npm run screenshots:generate`
4. Verify all E2E tests: `npm run test:e2e`

## Getting Help

- Open an issue for bugs or feature requests
- Check `docs/` for detailed documentation
- Review existing issues for ongoing work
