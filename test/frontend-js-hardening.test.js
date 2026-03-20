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
