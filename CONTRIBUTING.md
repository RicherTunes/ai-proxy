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

1. Create a feature branch from `master`
2. Make your changes with tests
3. Ensure all tests pass
4. Submit a PR with description
5. Respond to review feedback

## Getting Help

- Open an issue for bugs or feature requests
- Check `docs/` for detailed documentation
- Review existing issues for ongoing work
