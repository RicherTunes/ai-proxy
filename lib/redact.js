'use strict';

/**
 * Redaction utility for sensitive data in debug endpoint responses
 */

const REDACTED = '[REDACTED]';

// Patterns for sensitive data - order matters, more specific first
// Use negative lookahead to prevent sk- from matching sk-ant-
const API_KEY_PATTERNS = [
  /sk-ant-[a-zA-Z0-9-_]+/g,
  /sk-(?!ant-)[a-zA-Z0-9]+/g  // sk- but not sk-ant-
];

const SENSITIVE_FIELD_NAMES = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'authorization',
  'auth',
  'bearer'
]);

/**
 * Deep clone an object
 * @param {*} obj - Object to clone
 * @returns {*} Deep clone of the object
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }

  if (obj instanceof Array) {
    return obj.map(item => deepClone(item));
  }

  if (obj instanceof RegExp) {
    return new RegExp(obj.source, obj.flags);
  }

  const cloned = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      cloned[key] = deepClone(obj[key]);
    }
  }

  return cloned;
}

/**
 * Check if a field name is sensitive
 * @param {string} fieldName - Field name to check
 * @returns {boolean} True if field name is sensitive
 */
function isSensitiveFieldName(fieldName) {
  if (typeof fieldName !== 'string') {
    return false;
  }
  return SENSITIVE_FIELD_NAMES.has(fieldName.toLowerCase());
}

/**
 * Redact API key or token - show first 10 chars + "..."
 * @param {string} value - Value to redact
 * @returns {string} Redacted value
 */
function redactKey(value) {
  if (typeof value !== 'string') {
    return value;
  }

  if (value.length <= 10) {
    return REDACTED;
  }

  return value.substring(0, 10) + '...';
}

/**
 * Redact sensitive string patterns (API keys, tokens)
 * @param {string} str - String to redact
 * @returns {string} String with sensitive patterns redacted
 */
function redactPatterns(str) {
  if (typeof str !== 'string') {
    return str;
  }

  let result = str;

  for (const pattern of API_KEY_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.length <= 10) {
        return REDACTED;
      }
      return match.substring(0, 10) + '...';
    });
  }

  return result;
}

/**
 * Redact headers object
 * @param {Object} headers - Headers object
 * @returns {Object} Redacted headers
 */
function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return headers;
  }

  const redacted = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    // Fully redact authorization headers
    if (lowerKey === 'authorization') {
      redacted[key] = REDACTED;
      continue;
    }

    // Redact bearer tokens (show first 10 chars)
    if (typeof value === 'string' && value.toLowerCase().startsWith('bearer ')) {
      const token = value.substring(7); // Remove "Bearer " prefix
      if (token.length <= 10) {
        redacted[key] = 'Bearer ' + REDACTED;
      } else {
        redacted[key] = 'Bearer ' + token.substring(0, 10) + '...';
      }
      continue;
    }

    // Check if header name is sensitive
    if (isSensitiveFieldName(lowerKey)) {
      redacted[key] = typeof value === 'string' ? redactKey(value) : REDACTED;
      continue;
    }

    // Redact patterns in header values
    if (typeof value === 'string') {
      redacted[key] = redactPatterns(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Redact sensitive data from body
 * @param {*} body - Body data
 * @param {number} bodyPreviewLength - Max length for body preview
 * @returns {*} Redacted body
 */
function redactBody(body, bodyPreviewLength) {
  if (body === null || body === undefined) {
    return body;
  }

  // Truncate if bodyPreviewLength is specified
  if (bodyPreviewLength > 0) {
    if (typeof body === 'string' && body.length > bodyPreviewLength) {
      return body.substring(0, bodyPreviewLength) + '... [truncated]';
    }

    if (typeof body === 'object') {
      const str = JSON.stringify(body);
      if (str.length > bodyPreviewLength) {
        return str.substring(0, bodyPreviewLength) + '... [truncated]';
      }
    }
  }

  return body;
}

/**
 * Recursively redact sensitive data from an object
 * @param {*} obj - Object to redact
 * @param {Object} options - Redaction options
 * @returns {*} Redacted object
 */
function redactRecursive(obj, options) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle primitive types
  if (typeof obj !== 'object') {
    if (typeof obj === 'string') {
      return redactPatterns(obj);
    }
    return obj;
  }

  // Preserve Date objects
  if (obj instanceof Date) {
    return obj;  // Already cloned in deepClone
  }

  // Preserve RegExp objects
  if (obj instanceof RegExp) {
    return obj;  // Already cloned in deepClone
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => redactRecursive(item, options));
  }

  // Handle objects
  const redacted = {};

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();

    // Special handling for headers
    if (lowerKey === 'headers' && options.redactHeaders) {
      redacted[key] = redactHeaders(value);
      continue;
    }

    // Special handling for body
    if (lowerKey === 'body' && options.redactBodies) {
      redacted[key] = redactBody(
        redactRecursive(value, options),
        options.bodyPreviewLength
      );
      continue;
    }

    // Redact sensitive field names
    if (isSensitiveFieldName(key)) {
      if (typeof value === 'string') {
        redacted[key] = redactKey(value);
      } else {
        redacted[key] = REDACTED;
      }
      continue;
    }

    // Recursively process nested objects
    if (typeof value === 'object' && value !== null) {
      redacted[key] = redactRecursive(value, options);
    } else if (typeof value === 'string') {
      redacted[key] = redactPatterns(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Redact sensitive data from an object
 * @param {Object} obj - Object to redact
 * @param {Object} options - Redaction options
 * @param {boolean} [options.redactBodies=true] - Whether to redact request/response bodies
 * @param {boolean} [options.redactHeaders=true] - Whether to redact headers
 * @param {number} [options.bodyPreviewLength=0] - Max length for body preview (0 = no limit)
 * @returns {Object} Redacted deep clone of the object
 */
function redactSensitiveData(obj, options = {}) {
  const defaultOptions = {
    redactBodies: true,
    redactHeaders: true,
    bodyPreviewLength: 0
  };

  const mergedOptions = { ...defaultOptions, ...options };

  // Deep clone to avoid mutating original
  const cloned = deepClone(obj);

  // Recursively redact
  return redactRecursive(cloned, mergedOptions);
}

module.exports = {
  redactSensitiveData,
  REDACTED
};
