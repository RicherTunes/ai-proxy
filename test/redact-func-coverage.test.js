'use strict';

/**
 * redact-func-coverage.test.js
 * Pushes branch coverage for lib/redact.js to maximum.
 *
 * BEFORE branch coverage: 94.25% (uncovered: lines 51, 65, 77, 94, 180)
 *
 * Lines 65, 77, 94 are unreachable from the public API:
 *   - isSensitiveFieldName() is only called with Object.entries() keys (always strings)
 *   - redactKey() is only called after typeof value === 'string' check
 *   - redactPatterns() is only called after typeof value === 'string' check
 *
 * Lines 51 and 180 ARE reachable — tests target those.
 */

const { redactSensitiveData, REDACTED } = require('../lib/redact');

afterEach(() => {
  jest.restoreAllMocks();
});

describe('redact - deepClone hasOwnProperty false branch (line 51)', () => {
  // Covers line 51: deepClone skips inherited properties
  test('should not clone inherited prototype properties', () => {
    const proto = { inheritedSecret: 'should-not-appear' };
    const input = Object.create(proto);
    input.ownField = 'own-value';

    const output = redactSensitiveData(input);

    // Only own properties should be cloned
    expect(output.ownField).toBe('own-value');
    // Inherited properties should NOT appear in the clone
    expect(Object.prototype.hasOwnProperty.call(output, 'inheritedSecret')).toBe(false);
  });

  // Covers line 51: nested deepClone with inherited properties
  test('should skip inherited properties in nested objects', () => {
    const proto = { inherited: 'from-proto' };
    const nested = Object.create(proto);
    nested.ownKey = 'own-value';

    const input = { level1: nested, normalField: 'ok' };
    const output = redactSensitiveData(input);

    expect(output.level1.ownKey).toBe('own-value');
    expect(Object.prototype.hasOwnProperty.call(output.level1, 'inherited')).toBe(false);
    expect(output.normalField).toBe('ok');
  });
});

describe('redact - redactBody object within preview length (line 180)', () => {
  // Covers line 180: JSON stringified body fits within bodyPreviewLength
  test('should not truncate object body when JSON is within preview length', () => {
    const input = { body: { data: 'short' } };

    const output = redactSensitiveData(input, { bodyPreviewLength: 200 });

    // JSON.stringify({data:'short'}) = '{"data":"short"}' = 16 chars, well within 200
    expect(output.body).toEqual({ data: 'short' });
  });

  // Covers line 180: exact boundary — bodyPreviewLength equals stringified size
  test('should not truncate when stringified body equals preview length', () => {
    const body = { k: 'v' };
    const bodyStr = JSON.stringify(body);
    // '{"k":"v"}' = 9 chars

    const input = { body };
    const output = redactSensitiveData(input, { bodyPreviewLength: bodyStr.length });

    // Length is exactly equal, not greater, so no truncation
    expect(output.body).toEqual({ k: 'v' });
  });
});

describe('redact - unreachable branches documentation', () => {
  // These tests document the unreachable branches (lines 65, 77, 94)
  // They exercise the PUBLIC API paths that come closest to those branches.

  // Lines 77-78: redactKey non-string guard
  // redactKey is called at line 146 (redactHeaders) and line 247 (redactRecursive)
  // Both call sites check typeof value === 'string' first.
  // The REDACTED constant is returned instead of calling redactKey for non-strings.
  test('non-string sensitive field values return REDACTED without calling redactKey', () => {
    const input = { token: 42, secret: null, password: true };
    const output = redactSensitiveData(input);

    expect(output.token).toBe(REDACTED);
    expect(output.secret).toBe(REDACTED);
    expect(output.password).toBe(REDACTED);
  });

  // Lines 94-95: redactPatterns non-string guard
  // redactPatterns is called only inside typeof === 'string' checks
  // Non-string values in non-sensitive fields pass through the else branch at line 259-260
  test('non-string non-sensitive field values pass through unchanged', () => {
    const input = { count: 99, active: true, tags: [1, 2, 3] };
    const output = redactSensitiveData(input);

    expect(output.count).toBe(99);
    expect(output.active).toBe(true);
    expect(output.tags).toEqual([1, 2, 3]);
  });

  // Lines 65-66: isSensitiveFieldName non-string guard
  // isSensitiveFieldName receives keys from Object.entries() which are always strings
  test('all Object.entries keys are strings so isSensitiveFieldName always gets strings', () => {
    const input = { api_key: 'long-secret-key-value', normalField: 'safe' };
    const output = redactSensitiveData(input);

    // api_key is a sensitive field name (string), gets redacted
    expect(output.api_key).toBe('long-secre...');
    expect(output.normalField).toBe('safe');
  });
});
