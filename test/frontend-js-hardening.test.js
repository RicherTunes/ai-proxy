'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Frontend JS Hardening Tests
 *
 * TDD-driven safety checks for all public/js/ source files.
 * These tests read JS source files as strings and assert safety patterns.
 */

const publicJsDir = path.join(__dirname, '..', 'public', 'js');
const libDashboardPath = path.join(__dirname, '..', 'lib', 'dashboard.js');

function readJsFiles() {
  const files = {};
  const jsFileNames = fs.readdirSync(publicJsDir).filter(f => f.endsWith('.js'));
  for (const name of jsFileNames) {
    files[name] = fs.readFileSync(path.join(publicJsDir, name), 'utf8');
  }
  return files;
}

let jsFiles;
let libDashboardContent;

beforeAll(() => {
  jsFiles = readJsFiles();
  libDashboardContent = fs.readFileSync(libDashboardPath, 'utf8');
});

// ============================================================
// Group 1: No innerHTML with unescaped user data
// ============================================================
describe('Group 1: innerHTML safety — escapeHtml required', () => {
  test('every JS file that uses .innerHTML also references escapeHtml', () => {
    const violations = [];

    for (const [name, content] of Object.entries(jsFiles)) {
      const hasInnerHTML = /\.innerHTML\s*[+=]/.test(content);
      if (!hasInnerHTML) continue;

      // Check if the file only sets innerHTML to empty string or static HTML
      // (no variable interpolation at all)
      const innerHTMLAssignments = content.match(/\.innerHTML\s*[+=]\s*.+/g) || [];
      const hasDynamicContent = innerHTMLAssignments.some(assignment => {
        // Static: .innerHTML = '' or .innerHTML = '<div>static</div>'
        // Dynamic: uses + concatenation with variables, or template literals with ${}
        const rhs = assignment.replace(/\.innerHTML\s*[+=]\s*/, '');
        // If the RHS is just an empty string, it's safe
        if (/^['"](['"]|<[^'">]*>)*['"];\s*$/.test(rhs)) return false;
        if (/^''\s*;?\s*$/.test(rhs)) return false;
        // If the RHS references a variable (not just a string literal), it's dynamic
        return true;
      });

      if (!hasDynamicContent) continue;

      const hasEscapeHtml = content.includes('escapeHtml');
      if (!hasEscapeHtml) {
        violations.push(name);
      }
    }

    expect(violations).toEqual([]);
  });
});

// ============================================================
// Group 2: No inline onclick/event handlers in JS-generated HTML
// ============================================================
describe('Group 2: no inline event handlers in JS-generated HTML', () => {
  const inlineHandlerPattern = /on(click|change|submit|keydown|keyup|keypress|mouseover|mouseout|mouseenter|mouseleave|focus|blur|load|error|input|reset)="/i;

  test('no inline event handlers in public/js/ files', () => {
    const violations = [];

    for (const [name, content] of Object.entries(jsFiles)) {
      // Search for inline handlers in string literals and template literals
      const matches = content.match(new RegExp(inlineHandlerPattern.source, 'gi'));
      if (matches && matches.length > 0) {
        violations.push({ file: name, matches });
      }
    }

    expect(violations).toEqual([]);
  });

  test('no inline event handlers in lib/dashboard.js', () => {
    const matches = libDashboardContent.match(new RegExp(inlineHandlerPattern.source, 'gi'));
    expect(matches || []).toEqual([]);
  });
});

// ============================================================
// Group 3: JSON.parse always in try/catch
// ============================================================
describe('Group 3: JSON.parse always in try/catch', () => {
  test('every JSON.parse call is inside a try block', () => {
    const violations = [];

    for (const [name, content] of Object.entries(jsFiles)) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('JSON.parse(')) continue;
        // Skip JSON.parse inside JSON.stringify (like JSON.parse(JSON.stringify(...)))
        if (/JSON\.parse\(JSON\.stringify\(/.test(lines[i])) continue;

        // Look backwards up to 15 lines for a `try {` or `try{`
        let foundTry = false;
        let braceDepth = 0;
        for (let j = i; j >= Math.max(0, i - 15); j--) {
          const line = lines[j];
          // Count closing braces (going backwards, these are "opening" for us)
          const closeBraces = (line.match(/\}/g) || []).length;
          const openBraces = (line.match(/\{/g) || []).length;
          braceDepth += closeBraces - openBraces;

          if (/\btry\s*\{/.test(line) || /\btry\s*$/.test(line)) {
            // Only count if we haven't escaped the try block
            if (braceDepth <= 0) {
              foundTry = true;
              break;
            }
          }
        }

        // Also check if the line itself is inside a function that has try/catch wrapping
        // e.g., safeParseJson utility
        if (!foundTry) {
          // Check if this is the safeParseJson function (which has its own try/catch on the same line)
          if (/try\s*\{.*JSON\.parse/.test(lines[i])) {
            foundTry = true;
          }
        }

        if (!foundTry) {
          violations.push({
            file: name,
            line: i + 1,
            content: lines[i].trim()
          });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ============================================================
// Group 4: fetch/authFetch error handling
// ============================================================
describe('Group 4: fetch/authFetch chains have .catch() or try/catch', () => {
  test('every .then() chain on fetch/authFetch has error handling', () => {
    const violations = [];

    for (const [name, content] of Object.entries(jsFiles)) {
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Find lines that start a fetch/authFetch call with .then()
        // Look for: authFetch(...).then( or fetch(...).then(
        if (!/(authFetch|fetch)\s*\(/.test(line)) continue;
        if (!/\.then\s*\(/.test(line) && !/\.then\s*\(/.test(lines[i + 1] || '')) continue;

        // Check if this is inside an async function with try/catch
        let insideAsyncTryCatch = false;
        for (let j = i; j >= Math.max(0, i - 30); j--) {
          if (/\btry\s*\{/.test(lines[j])) {
            // Also check that there's an async function scope above the try
            for (let k = j; k >= Math.max(0, j - 10); k--) {
              if (/\basync\b/.test(lines[k])) {
                insideAsyncTryCatch = true;
                break;
              }
            }
            break;
          }
        }

        if (insideAsyncTryCatch) continue;

        // Look forward up to 100 lines for a .catch() (long .then() chains are common)
        let foundCatch = false;
        let parenDepth = 0;
        for (let j = i; j < Math.min(lines.length, i + 100); j++) {
          const fwdLine = lines[j];
          // Track paren depth to stay within the same chain
          parenDepth += (fwdLine.match(/\(/g) || []).length;
          parenDepth -= (fwdLine.match(/\)/g) || []).length;

          if (/\.catch\s*\(/.test(fwdLine)) {
            foundCatch = true;
            break;
          }

          // If we've closed all parens and started a new statement, stop
          if (j > i && parenDepth <= 0 && /;\s*$/.test(fwdLine)) break;
        }

        if (!foundCatch) {
          violations.push({
            file: name,
            line: i + 1,
            content: line.trim().substring(0, 120)
          });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ============================================================
// Group 5: No var redeclarations in same scope
// ============================================================
describe('Group 5: no var redeclarations in same scope', () => {
  test('no duplicate var declarations of the same name within a function', () => {
    const violations = [];

    for (const [name, content] of Object.entries(jsFiles)) {
      // Find all function bodies (approximate by matching function boundaries)
      // Use a simple approach: find all `var NAME` declarations per file
      // and flag names that appear more than once (excluding nested functions)
      const varPattern = /\bvar\s+(\w+)\b/g;
      const declarations = new Map(); // name -> [line numbers]
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        let match;
        const line = lines[i];
        const lineVarPattern = /\bvar\s+(\w+)\b/g;
        while ((match = lineVarPattern.exec(line)) !== null) {
          // Skip matches inside string literals:
          // Check if the match position is preceded by an odd number of quotes
          const beforeMatch = line.substring(0, match.index);
          const singleQuotes = (beforeMatch.match(/'/g) || []).length;
          const doubleQuotes = (beforeMatch.match(/"/g) || []).length;
          const backticks = (beforeMatch.match(/`/g) || []).length;
          if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0) {
            continue; // Inside a string literal
          }
          // Also skip if the line is a comment
          if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;

          const varName = match[1];
          if (!declarations.has(varName)) {
            declarations.set(varName, []);
          }
          declarations.get(varName).push(i + 1);
        }
      }

      // Flag vars declared more than once in the same file
      // (var hoisting makes this work but it indicates sloppy code)
      // Only flag if they appear in the same function scope (simple heuristic:
      // declarations within 100 lines of each other in the same file)
      for (const [varName, lineNums] of declarations) {
        if (lineNums.length <= 1) continue;

        // Check if these are genuinely in the same scope
        // Simple heuristic: skip if declarations are in obviously different function blocks
        // (e.g., separated by 'function ' declarations)
        let sameScope = false;
        for (let a = 0; a < lineNums.length - 1; a++) {
          for (let b = a + 1; b < lineNums.length; b++) {
            const start = lineNums[a] - 1;
            const end = lineNums[b] - 1;
            // Check if there's a function boundary between them
            let hasFunctionBoundary = false;
            for (let k = start + 1; k < end; k++) {
              if (/\bfunction\s+\w+\s*\(/.test(lines[k]) || /\bfunction\s*\(/.test(lines[k])) {
                hasFunctionBoundary = true;
                break;
              }
            }
            if (!hasFunctionBoundary) {
              sameScope = true;
              break;
            }
          }
          if (sameScope) break;
        }

        if (sameScope) {
          violations.push({
            file: name,
            variable: varName,
            lines: lineNums
          });
        }
      }
    }

    // Known acceptable patterns: loop variables (i, j, k), common iterators
    const filtered = violations.filter(v =>
      !['i', 'j', 'k', 'el', 'entry', 'match', 'node'].includes(v.variable)
    );

    expect(filtered).toEqual([]);
  });
});

// ============================================================
// Group 6: Event listener cleanup in TierBuilder
// ============================================================
describe('Group 6: TierBuilder event listener cleanup', () => {
  test('every addEventListener in TierBuilder constructor has matching removeEventListener in destroy', () => {
    const tierBuilderContent = jsFiles['tier-builder.js'];
    expect(tierBuilderContent).toBeDefined();

    // Extract the constructor body (from "function TierBuilder()" to the next prototype method)
    const constructorMatch = tierBuilderContent.match(
      /function TierBuilder\(\)\s*\{([\s\S]*?)^\s*\}/m
    );
    // Use a broader match - find from TierBuilder() to the first prototype assignment
    const constructorStart = tierBuilderContent.indexOf('function TierBuilder()');
    const firstPrototype = tierBuilderContent.indexOf('TierBuilder.prototype.render');
    const constructorBody = tierBuilderContent.substring(constructorStart, firstPrototype);

    // Extract the destroy body
    const destroyStart = tierBuilderContent.indexOf('TierBuilder.prototype.destroy = function()');
    const destroyEnd = tierBuilderContent.indexOf('// ========== MODEL ROUTING FUNCTIONS', destroyStart);
    const destroyBody = tierBuilderContent.substring(destroyStart, destroyEnd);

    // Find all addEventListener calls in constructor
    const addListenerPattern = /addEventListener\(\s*'(\w+)'/g;
    const constructorListeners = [];
    let addMatch;
    while ((addMatch = addListenerPattern.exec(constructorBody)) !== null) {
      constructorListeners.push(addMatch[1]);
    }

    // Find all removeEventListener calls in destroy
    const removeListenerPattern = /removeEventListener\(\s*'(\w+)'/g;
    const destroyListeners = [];
    let removeMatch;
    while ((removeMatch = removeListenerPattern.exec(destroyBody)) !== null) {
      destroyListeners.push(removeMatch[1]);
    }

    // Every event type added in the constructor should be removed in destroy
    const missingCleanup = constructorListeners.filter(
      eventType => !destroyListeners.includes(eventType)
    );

    expect(missingCleanup).toEqual([]);
  });

  test('TierBuilder destroy method exists and cleans up sortables', () => {
    const tierBuilderContent = jsFiles['tier-builder.js'];
    expect(tierBuilderContent).toContain('TierBuilder.prototype.destroy');
    expect(tierBuilderContent).toContain('_destroySortables');
    expect(tierBuilderContent).toContain('_destroyed = true');
  });
});

// ============================================================
// Group 7: context-menu.js uses removable event listeners
// ============================================================
describe('Group 7: context-menu.js uses removable event listeners', () => {
  test('addEventListener calls use named handlers or AbortController, not anonymous functions', () => {
    const content = jsFiles['context-menu.js'];
    expect(content).toBeDefined();

    // Find all addEventListener calls
    const addListenerRegex = /addEventListener\(\s*['"][^'"]+['"]\s*,\s*(function\s*\(|(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*=>)/g;
    const anonymousMatches = [];
    let match;
    while ((match = addListenerRegex.exec(content)) !== null) {
      anonymousMatches.push({
        snippet: content.substring(match.index, match.index + 80).trim(),
        line: content.substring(0, match.index).split('\n').length
      });
    }

    // Should have zero anonymous handlers in addEventListener calls
    expect(anonymousMatches).toEqual([]);
  });

  test('has a destroy() or cleanup() method that can remove all listeners', () => {
    const content = jsFiles['context-menu.js'];
    expect(content).toBeDefined();

    const hasDestroyOrCleanup =
      content.includes('.destroy') ||
      content.includes('.cleanup') ||
      content.includes('AbortController');

    expect(hasDestroyOrCleanup).toBe(true);
  });
});

// ============================================================
// Group 8: progressive-disclosure.js uses removable event listeners
// ============================================================
describe('Group 8: progressive-disclosure.js uses removable event listeners', () => {
  test('addEventListener calls use named handlers or AbortController, not anonymous functions', () => {
    const content = jsFiles['progressive-disclosure.js'];
    expect(content).toBeDefined();

    // Find all addEventListener calls with anonymous function or arrow handlers
    const addListenerRegex = /addEventListener\(\s*['"][^'"]+['"]\s*,\s*(function\s*\(|(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*=>)/g;
    const anonymousMatches = [];
    let match;
    while ((match = addListenerRegex.exec(content)) !== null) {
      anonymousMatches.push({
        snippet: content.substring(match.index, match.index + 80).trim(),
        line: content.substring(0, match.index).split('\n').length
      });
    }

    expect(anonymousMatches).toEqual([]);
  });

  test('has a destroy() or cleanup() method', () => {
    const content = jsFiles['progressive-disclosure.js'];
    expect(content).toBeDefined();

    const hasDestroyOrCleanup =
      content.includes('.destroy') ||
      content.includes('.cleanup') ||
      content.includes('AbortController');

    expect(hasDestroyOrCleanup).toBe(true);
  });
});

// ============================================================
// Group 9: All manager classes with init() have matching destroy/cleanup
// ============================================================
describe('Group 9: managers with init() + addEventListener have destroy/cleanup', () => {
  test('every manager/class with init() that calls addEventListener also has destroy/cleanup/dispose', () => {
    const violations = [];

    for (const [name, content] of Object.entries(jsFiles)) {
      // Find constructor functions (function Foo() { ... })
      const constructorPattern = /function\s+([A-Z]\w+)\s*\(\)/g;
      let ctorMatch;
      while ((ctorMatch = constructorPattern.exec(content)) !== null) {
        const className = ctorMatch[1];

        // Check if this class has an init() method
        const hasInit =
          content.includes(className + '.prototype.init') ||
          content.includes('this.init()');

        if (!hasInit) continue;

        // Check if init() or the constructor calls addEventListener
        // We look for addEventListener in the constructor body and in prototype.init
        const hasAddEventListener = content.includes('addEventListener');

        if (!hasAddEventListener) continue;

        // Check for destroy/cleanup/dispose method
        const hasCleanup =
          content.includes(className + '.prototype.destroy') ||
          content.includes(className + '.prototype.cleanup') ||
          content.includes(className + '.prototype.dispose') ||
          content.includes('AbortController');

        if (!hasCleanup) {
          violations.push({ file: name, class: className });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ============================================================
// Group 10: No duplicate event listener registration risk
// ============================================================
describe('Group 10: addEventListener in repeatable methods is guarded', () => {
  test('addEventListener inside init()/render()/update() uses AbortController or guard', () => {
    const violations = [];

    for (const [name, content] of Object.entries(jsFiles)) {
      const lines = content.split('\n');

      // Find all addEventListener calls
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('addEventListener')) continue;

        // Check if this addEventListener is inside a method that could be called multiple times
        // Look backward for method definition patterns
        let insideRepeatableMethod = false;
        let methodName = '';
        for (let j = i; j >= Math.max(0, i - 30); j--) {
          // Prototype method: Foo.prototype.init = function
          const protoMatch = lines[j].match(/\.prototype\.(init|render|update|refresh|start|attach|connect)\s*=/);
          if (protoMatch) {
            insideRepeatableMethod = true;
            methodName = protoMatch[1];
            break;
          }
          // Object method: init: function
          const objMatch = lines[j].match(/\b(init|render|update|refresh|start|attach|connect)\s*[:=]\s*function/);
          if (objMatch) {
            insideRepeatableMethod = true;
            methodName = objMatch[1];
            break;
          }
        }

        if (!insideRepeatableMethod) continue;

        // Check if guarded: look for AbortController signal, or an idempotency guard
        let isGuarded = false;

        // Check for AbortController signal in the addEventListener options
        // Look at the current addEventListener call and nearby lines
        const nearbyContent = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 5)).join('\n');
        if (nearbyContent.includes('signal') || nearbyContent.includes('AbortController')) {
          isGuarded = true;
        }

        // Check for idempotency guard earlier in the method (e.g., "if (this._listenersAttached) return")
        for (let j = i; j >= Math.max(0, i - 20); j--) {
          if (lines[j].includes('_attached') || lines[j].includes('_initialized') ||
              lines[j].includes('_bound') || lines[j].includes('_listening') ||
              lines[j].includes('if (this._') || lines[j].includes('_sseAttached')) {
            isGuarded = true;
            break;
          }
        }

        // Check for removeEventListener or abort() before the addEventListener
        for (let j = i; j >= Math.max(0, i - 10); j--) {
          if (lines[j].includes('removeEventListener') || lines[j].includes('.abort()') ||
              lines[j].includes('.disconnect()')) {
            isGuarded = true;
            break;
          }
        }

        // Skip DOMContentLoaded since it only fires once
        if (lines[i].includes('DOMContentLoaded')) {
          isGuarded = true;
        }

        // Skip event delegation on dynamically created elements (these are new elements each time)
        // e.g., inside forEach on querySelectorAll results that are rendered fresh
        for (let j = i; j >= Math.max(0, i - 10); j--) {
          if (lines[j].includes('.forEach(') || lines[j].includes('createElement(')) {
            isGuarded = true;
            break;
          }
        }

        if (!isGuarded) {
          violations.push({
            file: name,
            line: i + 1,
            method: methodName,
            content: lines[i].trim().substring(0, 120)
          });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ============================================================
// Group 11: No duplicate escapeHtml declarations in routing.js
// ============================================================
describe('Group 11: no duplicate escapeHtml in routing.js', () => {
  test('public/dashboard/routing.js must NOT declare escapeHtml more than once', () => {
    const routingPath = path.join(__dirname, '..', 'public', 'dashboard', 'routing.js');
    const content = fs.readFileSync(routingPath, 'utf8');

    // Match all declarations: const escapeHtml, let escapeHtml, var escapeHtml, function escapeHtml
    const declarations = content.match(/\b(const|let|var|function)\s+escapeHtml\b/g) || [];
    expect(declarations.length).toBe(1);
  });
});

// ============================================================
// Group 12: Filter chip value must be escaped in filters.js
// ============================================================
describe('Group 12: filter chip innerHTML escapes value in filters.js', () => {
  test('the innerHTML assignment building filter chips wraps value in escapeHtml()', () => {
    const content = jsFiles['filters.js'];
    expect(content).toBeDefined();

    // Find the innerHTML assignment that builds filter chips (label + value pattern)
    const chipInnerHTMLLines = content.split('\n').filter(line =>
      line.includes('chip.innerHTML') && line.includes('label')
    );
    expect(chipInnerHTMLLines.length).toBeGreaterThan(0);

    for (const line of chipInnerHTMLLines) {
      // The value variable must be wrapped in escapeHtml() before insertion
      // We check that any occurrence of `+ value +` or `+ value '` is actually `+ escapeHtml(value) +`
      // i.e., raw `value` should NOT appear unescaped in the innerHTML string
      const hasUnescapedValue = /\+\s*value\s*\+/.test(line) || /\+\s*value\s*'/.test(line);
      const hasEscapedValue = /escapeHtml\(value\)/.test(line);
      expect(hasUnescapedValue && !hasEscapedValue).toBe(false);
    }
  });
});

// ============================================================
// Group 13: Cooldown list in data.js must escape interpolated values
// ============================================================
describe('Group 13: cooldownList innerHTML escapes values in data.js', () => {
  test('cooldownList innerHTML uses escapeHtml or textContent instead of raw interpolation', () => {
    const content = jsFiles['data.js'];
    expect(content).toBeDefined();

    const lines = content.split('\n');
    // Find the cooldownList innerHTML assignment
    let cooldownBlock = '';
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('cooldownList.innerHTML') && lines[i].includes('cooldownKeys')) {
        // Grab surrounding lines for context (the block may span multiple lines)
        cooldownBlock = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
        break;
      }
      // Also match if cooldownList.innerHTML is on one line and cooldownKeys on the next
      if (lines[i].includes('cooldownList.innerHTML') && i + 1 < lines.length && lines[i + 1].includes('cooldownKeys')) {
        cooldownBlock = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
        break;
      }
    }

    // If the block uses innerHTML, it must either:
    // 1. Use escapeHtml() on interpolated values, OR
    // 2. Use textContent instead of innerHTML
    if (cooldownBlock.includes('.innerHTML')) {
      // The map function building HTML should use escapeHtml on k.index and the remainingMs expression
      const usesTextContent = cooldownBlock.includes('.textContent');
      const usesEscapeHtml = cooldownBlock.includes('escapeHtml');
      expect(usesTextContent || usesEscapeHtml).toBe(true);
    }
    // If it uses textContent, that's inherently safe — test passes
  });
});
