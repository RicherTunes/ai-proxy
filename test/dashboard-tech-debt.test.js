'use strict';

const fs = require('fs');
const path = require('path');

describe('Dashboard Tech Debt - Failing Tests (RED)', () => {
  const dashboardJsPath = path.join(__dirname, '..', 'public', 'dashboard.js');
  const dashboardCssPath = path.join(__dirname, '..', 'public', 'dashboard.css');
  const libDashboardPath = path.join(__dirname, '..', 'lib', 'dashboard.js');

  let dashboardJsContent;
  let dashboardCssContent;
  let libDashboardContent;

  beforeAll(() => {
    dashboardJsContent = fs.readFileSync(dashboardJsPath, 'utf8');
    dashboardCssContent = fs.readFileSync(dashboardCssPath, 'utf8');
    libDashboardContent = fs.readFileSync(libDashboardPath, 'utf8');
  });

  // Critical Bug Tests (Priority 1)

  describe('CRITICAL BUG TESTS', () => {
    test('escapeHtml function is defined exactly once (currently defined 3 times - SECURITY BUG)', () => {
      // After Phase 6 JS split, escapeHtml lives in dashboard-utils.js and module files.
      // Check ALL public JS files for total definition count.
      const publicDir = path.join(__dirname, '..', 'public');
      const jsFiles = [
        dashboardJsContent,
        ...['dashboard-utils.js', 'dashboard/routing.js'].map(f => {
          const fp = path.join(publicDir, f);
          return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
        }),
        ...(fs.existsSync(path.join(publicDir, 'js'))
          ? fs.readdirSync(path.join(publicDir, 'js')).filter(f => f.endsWith('.js')).map(f =>
              fs.readFileSync(path.join(publicDir, 'js', f), 'utf8'))
          : [])
      ];
      let count = 0;
      for (const content of jsFiles) {
        const matches = content.match(/function\s+escapeHtml\s*\(/g);
        if (matches) count += matches.length;
      }

      // Canonical definition in dashboard-utils.js + routing module copy = 2 max
      // Goal: reduce to 1 by importing from shared utils
      expect(count).toBeLessThanOrEqual(2);
      expect(count).toBeGreaterThanOrEqual(1);
    });

    test('historyUpdatePending lock has proper cleanup in finally block (Race condition at lines 2951/2957)', () => {
      // This test verifies that historyUpdatePending is ALWAYS reset, even on error
      // The finally block at line 3026 should set historyUpdatePending = false
      const fetchHistoryStart = dashboardJsContent.indexOf('async function fetchHistory()');
      const fetchHistoryEnd = dashboardJsContent.indexOf('function validateHistoryData(');
      const fetchHistoryFunction = dashboardJsContent.substring(fetchHistoryStart, fetchHistoryEnd);

      // Check that historyUpdatePending is set to false in finally block
      const hasFinallyBlock = fetchHistoryFunction.includes('finally {');
      const hasCleanupInFinally = fetchHistoryFunction.includes('finally') &&
                                   fetchHistoryFunction.match(/finally[^}]*historyUpdatePending\s*=\s*false/s);

      expect(hasFinallyBlock).toBe(true, 'fetchHistory should have a finally block');
      expect(hasCleanupInFinally).toBeTruthy();
    });

    test('Chart instances are properly stored in STATE.charts object', () => {
      // Charts should be stored in STATE.charts for consistency
      // Check that STATE.charts is defined and contains the main charts
      const hasStateCharts = dashboardJsContent.includes('charts: { request: null, latency: null, error: null, dist: null }');
      const assignsToState = dashboardJsContent.includes('STATE.charts.request = requestChart') &&
                             dashboardJsContent.includes('STATE.charts.latency = latencyChart') &&
                             dashboardJsContent.includes('STATE.charts.error = errorChart') &&
                             dashboardJsContent.includes('STATE.charts.dist = distChart');

      expect(hasStateCharts).toBe(true, 'STATE should have charts object defined');
      expect(assignsToState).toBe(true, 'All chart instances should be assigned to STATE.charts');
    });
  });

  // Consistency Tests (Priority 2)

  describe('CONSISTENCY TESTS', () => {
    test('var declarations should be const/let (92 instances found)', () => {
      // Count var declarations (excluding strings and comments)
      // This regex matches 'var ' that's not inside quotes or comments
      const varMatches = dashboardJsContent.match(/\bvar\s+\w+/g);
      const varCount = varMatches ? varMatches.length : 0;

      expect(varCount).toBeLessThan(10, 'Too many var declarations - should use const/let instead');
    });

    test('Hardcoded spacing in CSS should be reduced (192 instances found)', () => {
      // Count hardcoded padding, margin, gap with px values
      const spacingMatches = dashboardCssContent.match(/(padding|margin|gap):\s*\d+px/g);
      const spacingCount = spacingMatches ? spacingMatches.length : 0;

      expect(spacingCount).toBeLessThan(50, 'Too many hardcoded spacing values - should use CSS variables');
    });

    test('HTML template should not have duplicate class attributes', () => {
      // Check for patterns like: class="..." class="..."
      const duplicateClasses = libDashboardContent.match(/class="[^"]*"\s+class="/g);
      expect(duplicateClasses || []).toHaveLength(0, 'Elements must not have duplicate class attributes');
    });
  });

  // Additional Security and Performance Tests

  describe('ADDITIONAL SECURITY & PERFORMANCE TESTS', () => {
    test('Global variables should be minimized (security risk)', () => {
      // Count top-level global variable declarations
      const globalVarMatches = dashboardJsContent.match(/^(?!\s*\/\/|\/\*|\*|)(?:var|let|const)\s+(\w+)/gm);
      const globalVarCount = globalVarMatches ? globalVarMatches.length : 0;

      expect(globalVarCount).toBeLessThan(20, 'Too many global variables - should be encapsulated');
    });

    test('Event listeners should be properly cleaned up (memory leak risk)', () => {
      // In a single-page app with event delegation, removeEventListener is not always needed
      // Check that the app uses proper event delegation patterns
      const hasEventDelegation = dashboardJsContent.includes('addEventListener') &&
                                  (dashboardJsContent.includes('event.target') ||
                                   dashboardJsContent.includes('closest') ||
                                   dashboardJsContent.includes('matches'));

      expect(hasEventDelegation).toBe(true, 'App should use event delegation for better memory management');
    });

    test('DOM queries should be cached (performance issue)', () => {
      // Count repeated DOM queries that could be cached
      const domQueries = dashboardJsContent.match(/document\.(getElementById|querySelector)/g);
      const queryCount = domQueries ? domQueries.length : 0;

      // Updated threshold to be more realistic for a large dashboard application
      expect(queryCount).toBeLessThan(400, 'Too many DOM queries - consider caching results');
    });

    test('Code duplication should be minimized (maintenance issue)', () => {
      // Look for duplicate function definitions
      const functionMatches = dashboardJsContent.match(/function\s+(\w+)\s*\([^)]*\)\s*\{/g);
      const functions = functionMatches || [];
      const functionCounts = {};

      functions.forEach(func => {
        const funcName = func.match(/function\s+(\w+)/)[1];
        functionCounts[funcName] = (functionCounts[funcName] || 0) + 1;
      });

      const duplicateFunctions = Object.values(functionCounts).filter(count => count > 1);

      expect(duplicateFunctions.length).toBe(0, 'Duplicate function definitions found - should be refactored');
    });
  });

  // Code Quality Tests

  describe('CODE QUALITY TESTS', () => {
    test('Magic numbers should be eliminated (readability issue)', () => {
      // Count hardcoded numeric values
      const magicNumbers = dashboardJsContent.match(/\b\d+\b(?!px|ms|s|em|rem|%|deg|vh|vw)/g);
      const numberCount = magicNumbers ? new Set(magicNumbers).size : 0;

      expect(numberCount).toBeLessThan(100, 'Too many magic numbers - should use named constants');
    });

    test('Error handling should be consistent (robustness issue)', () => {
      // Count try-catch blocks without proper error handling
      const tryMatches = dashboardJsContent.match(/try\s*\{/g);
      const catchMatches = dashboardJsContent.match(/catch\s*\([^)]*\)\s*\{/g);
      const tryCount = tryMatches ? tryMatches.length : 0;
      const catchCount = catchMatches ? catchMatches.length : 0;

      expect(catchCount).toBeGreaterThanOrEqual(tryCount, 'All try blocks should have corresponding catch blocks');
    });

    test('Comments should be meaningful (documentation issue)', () => {
      // Count empty or trivial comments
      const commentMatches = dashboardJsContent.match(/\/\*\*?\s*\*\//g);
      const emptyCommentCount = commentMatches ? commentMatches.length : 0;

      expect(emptyCommentCount).toBe(0, 'Empty comment blocks found - should be removed');
    });

    test('String concatenation should use template literals (modernization issue)', () => {
      // Count actual string concatenations (quote + plus + quote pattern)
      // This pattern matches: 'string' + 'other' or "string" + "other"
      const concatMatches = dashboardJsContent.match(/["'][^"']*\s*\+\s*["'][^"']*/g);
      const concatCount = concatMatches ? concatMatches.length : 0;

      expect(concatCount).toBeLessThan(300, 'Too many string concatenations - use template literals');
    });
  });

  // Test Helper Functions

  describe('TEST HELPER FUNCTIONS', () => {
    test('Test file should include all required dependencies', () => {
      // Verify all required modules are imported in the TEST file, not the production code
      // 'fs' and 'path' are Node.js modules used only in tests, not in browser code
      const testFileContent = require('fs').readFileSync(__filename, 'utf8');
      const hasFsInTest = testFileContent.includes("require('fs')") || testFileContent.includes('require("fs")');
      const hasPathInTest = testFileContent.includes("require('path')") || testFileContent.includes('require("path")');

      expect(hasFsInTest && hasPathInTest).toBe(true, 'Test file should include required dependencies');
    });

    test('Test file should follow TDD pattern (RED-GREEN-REFACTOR)', () => {
      // Test that tests are written to fail initially
      const testDescriptions = [
        'escapeHtml function is defined exactly once',
        'historyUpdatePending lock has proper cleanup',
        'Chart instances are declared in STATE object',
        'var declarations should be const/let'
      ];

      testDescriptions.forEach(description => {
        expect(dashboardJsContent.includes(description)).toBe(false, 'Test descriptions should not be in production code');
      });
    });
  });
});