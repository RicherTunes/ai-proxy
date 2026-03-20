'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Frontend Hardening Tests
 *
 * TDD-driven structural quality checks for CSS and HTML template.
 * Tests read CSS/HTML as strings and assert quality invariants.
 */

const CSS_DIR = path.join(__dirname, '..', 'public', 'css');
const TOKENS_CSS_PATH = path.join(CSS_DIR, 'tokens.css');
const LIB_DASHBOARD_PATH = path.join(__dirname, '..', 'lib', 'dashboard.js');

/** Load all CSS files from public/css/ */
function loadAllCssFiles() {
  const files = fs.readdirSync(CSS_DIR).filter(f => f.endsWith('.css'));
  return files.map(f => ({
    name: f,
    path: path.join(CSS_DIR, f),
    content: fs.readFileSync(path.join(CSS_DIR, f), 'utf8'),
  }));
}

/** Also include the legacy public/dashboard.css */
function loadAllCssFilesIncludingLegacy() {
  const files = loadAllCssFiles();
  const legacyCss = path.join(__dirname, '..', 'public', 'dashboard.css');
  if (fs.existsSync(legacyCss)) {
    files.push({
      name: 'dashboard.css (legacy)',
      path: legacyCss,
      content: fs.readFileSync(legacyCss, 'utf8'),
    });
  }
  return files;
}

describe('Frontend Hardening', () => {
  let allCssFiles;
  let tokensCss;
  let libDashboardContent;

  beforeAll(() => {
    // Only scan modular CSS files in public/css/ — the dashboard loads these,
    // not the legacy monolith public/dashboard.css.
    allCssFiles = loadAllCssFiles();
    tokensCss = fs.readFileSync(TOKENS_CSS_PATH, 'utf8');
    libDashboardContent = fs.readFileSync(LIB_DASHBOARD_PATH, 'utf8');
  });

  // ─── GROUP 1: No duplicate @keyframes ───────────────────────────────
  describe('Group 1: No duplicate @keyframes', () => {
    test('no @keyframes name appears more than once across all CSS files combined', () => {
      const keyframeNames = {};

      for (const file of allCssFiles) {
        const regex = /@keyframes\s+([\w-]+)/g;
        let match;
        while ((match = regex.exec(file.content)) !== null) {
          const name = match[1];
          if (!keyframeNames[name]) {
            keyframeNames[name] = [];
          }
          keyframeNames[name].push(file.name);
        }
      }

      const duplicates = Object.entries(keyframeNames)
        .filter(([, files]) => files.length > 1)
        .map(([name, files]) => `@keyframes ${name} defined in: ${files.join(', ')}`);

      expect(duplicates).toEqual([]);
    });
  });

  // ─── GROUP 2: CSS variable consistency ──────────────────────────────
  describe('Group 2: CSS variable consistency', () => {
    const TARGET_COLORS = [
      '#22d3ee',
      '#94a3b8',
      '#e2e8f0',
      '#334155',
      '#ef4444',
      '#22c55e',
      '#f59e0b',
    ];

    test('common colors should not be hardcoded outside tokens.css (should use var() references)', () => {
      const violations = [];

      for (const file of allCssFiles) {
        // Skip tokens.css — that's where they should be defined
        if (file.name === 'tokens.css') continue;

        const lines = file.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          // Skip lines inside rgba() functions — those are acceptable
          // We check each target color individually
          for (const color of TARGET_COLORS) {
            const colorLower = color.toLowerCase();
            const lineLower = line.toLowerCase();
            const idx = lineLower.indexOf(colorLower);
            if (idx === -1) continue;

            // Check if it's inside an rgba() context — look for rgba( before this position
            const before = lineLower.substring(0, idx);
            const after = lineLower.substring(idx);
            // If there's an open rgba( or color-mix( that hasn't been closed, skip
            const inRgba = (before.lastIndexOf('rgba(') > before.lastIndexOf(')'));
            const inColorMix = (before.lastIndexOf('color-mix(') > before.lastIndexOf(')'));
            if (inRgba || inColorMix) continue;

            // Allow colors used as CSS var() fallback values: var(--name, #color)
            const inVarFallback = (before.lastIndexOf('var(') > before.lastIndexOf(')'));
            if (inVarFallback) continue;

            violations.push(
              `${file.name}:${i + 1} — hardcoded ${color} found: ${line.trim().substring(0, 100)}`
            );
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  // ─── GROUP 3: Responsive breakpoint coverage ────────────────────────
  describe('Group 3: Responsive breakpoint coverage', () => {
    test('grid-template-columns with fixed multi-column counts should have responsive breakpoints', () => {
      const violations = [];

      // Utility classes that are handled by centralized responsive rules
      const utilityClassExceptions = [
        '.grid-2', '.grid-3', '.grid-4',
        '.dashboard-grid.grid-3col', '.dashboard-grid.grid-2col', '.dashboard-grid.grid-1col',
      ];

      for (const file of allCssFiles) {
        const content = file.content;

        // Find all grid-template-columns with fixed column patterns
        // Match: repeat(N, ...) where N>1, or literal multi-column like "1fr 1fr"
        const lines = content.split('\n');
        let insideMediaQuery = false;
        let braceDepth = 0;
        let mediaQueryDepth = -1;
        let currentSelector = '';

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          // Track if we're inside a @media query
          if (line.match(/@media\s/)) {
            insideMediaQuery = true;
            mediaQueryDepth = braceDepth;
          }

          // Count braces
          for (const ch of line) {
            if (ch === '{') braceDepth++;
            if (ch === '}') {
              braceDepth--;
              if (insideMediaQuery && braceDepth <= mediaQueryDepth) {
                insideMediaQuery = false;
                mediaQueryDepth = -1;
              }
            }
          }

          // Track selector
          if (line.includes('{') && !line.match(/@/)) {
            currentSelector = line.split('{')[0].trim();
          }

          // Skip if inside @media query (already responsive)
          if (insideMediaQuery) continue;

          // Check for fixed multi-column grid patterns
          const gtcMatch = line.match(/grid-template-columns\s*:\s*(.+)/);
          if (!gtcMatch) continue;

          const value = gtcMatch[1].replace(/;.*/, '').trim();

          // Check for repeat(N, ...) where N > 1
          const repeatMatch = value.match(/repeat\s*\(\s*(\d+)/);
          if (repeatMatch && parseInt(repeatMatch[1], 10) > 1) {
            // Check if it's auto-fit or auto-fill (responsive by nature)
            if (value.includes('auto-fit') || value.includes('auto-fill')) continue;

            // Check if it's a utility class exception
            const isException = utilityClassExceptions.some(cls =>
              currentSelector.includes(cls.replace('.', ''))
            );
            if (isException) continue;

            // Check if this file (or any modular CSS file) has a @media breakpoint
            // that targets the same selector with grid-template-columns override.
            // Use [\s\S]*? to cross nested brace boundaries.
            const selectorBase = currentSelector.split(/[.#\[:]/)[0] || currentSelector;
            const selectorForRegex = currentSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const hasResponsive = allCssFiles.some(f =>
              f.content.match(
                new RegExp(`@media[\\s\\S]*?${selectorForRegex}[\\s\\S]*?grid-template-columns`, 's')
              )
            );
            if (hasResponsive) continue;

            violations.push(
              `${file.name}:${i + 1} — selector "${currentSelector}" has fixed grid repeat(${repeatMatch[1]}, ...) without responsive breakpoint`
            );
          }

          // Check for literal multi-column like "1fr 1fr" or "1fr 1fr 1fr"
          const literalCols = value.match(/^(\d*fr\s+){1,}\d*fr$/);
          if (literalCols) {
            const colCount = value.split(/\s+/).filter(s => s.includes('fr')).length;
            if (colCount > 1) {
              const isException = utilityClassExceptions.some(cls =>
                currentSelector.includes(cls.replace('.', ''))
              );
              if (isException) continue;

              const selectorForRegex = currentSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const hasResponsive = allCssFiles.some(f =>
                f.content.match(
                  new RegExp(`@media[\\s\\S]*?${selectorForRegex}[\\s\\S]*?grid-template-columns`, 's')
                )
              );
              if (hasResponsive) continue;

              violations.push(
                `${file.name}:${i + 1} — selector "${currentSelector}" has fixed ${colCount}-column grid without responsive breakpoint`
              );
            }
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  // ─── GROUP 4: No deprecated CSS ────────────────────────────────────
  describe('Group 4: No deprecated CSS', () => {
    test('no file contains -webkit-overflow-scrolling', () => {
      const violations = [];
      for (const file of allCssFiles) {
        if (file.content.includes('-webkit-overflow-scrolling')) {
          violations.push(file.name);
        }
      }
      expect(violations).toEqual([]);
    });

    test('no file contains clip: rect(', () => {
      const violations = [];
      for (const file of allCssFiles) {
        if (file.content.includes('clip: rect(')) {
          violations.push(file.name);
        }
      }
      expect(violations).toEqual([]);
    });
  });

  // ─── GROUP 5: Template accessibility basics ─────────────────────────
  describe('Group 5: Template accessibility basics', () => {
    let templateHtml;

    beforeAll(() => {
      // Extract the HTML template from lib/dashboard.js
      // The generateDashboard function returns template literal HTML
      const { generateDashboard } = require('../lib/dashboard');
      templateHtml = generateDashboard();
    });

    test('all icon-only buttons have aria-label', () => {
      // Find <button elements that contain only SVG/icon content (no text)
      // Pattern: <button...>...<svg...>...</svg>...</button> with no visible text
      const buttonRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
      const violations = [];
      let match;

      while ((match = buttonRegex.exec(templateHtml)) !== null) {
        const attrs = match[1];
        const content = match[2].trim();

        // Check if the button contains only SVG/icon content (no visible text)
        const textContent = content
          .replace(/<svg[\s\S]*?<\/svg>/gi, '')  // remove SVGs
          .replace(/<[^>]*>/g, '')                 // remove all HTML tags
          .replace(/&[a-z]+;/gi, '')               // remove HTML entities
          .trim();

        // If there's no visible text content, it's an icon-only button
        if (textContent.length === 0 && content.includes('<svg')) {
          // Check if it has aria-label
          if (!attrs.includes('aria-label')) {
            // Extract a snippet for identification
            const snippet = match[0].substring(0, 120);
            violations.push(`Icon-only button missing aria-label: ${snippet}...`);
          }
        }
      }

      expect(violations).toEqual([]);
    });

    test('modal overlays have role="dialog"', () => {
      // Find modal-overlay elements and check for role="dialog"
      const modalRegex = /class="[^"]*modal-overlay[^"]*"/g;
      const modalMatches = templateHtml.match(modalRegex) || [];

      // There should be at least one modal
      expect(modalMatches.length).toBeGreaterThan(0);

      // For each modal-overlay, check the surrounding element for role="dialog"
      const overlayRegex = /<[^>]*class="[^"]*modal-overlay[^"]*"[^>]*>/g;
      let overlayMatch;
      const violations = [];

      while ((overlayMatch = overlayRegex.exec(templateHtml)) !== null) {
        const tag = overlayMatch[0];
        if (!tag.includes('role="dialog"')) {
          violations.push(`Modal overlay missing role="dialog": ${tag.substring(0, 100)}`);
        }
      }

      expect(violations).toEqual([]);
    });

    test('SVG icons include aria-hidden="true"', () => {
      // Find all <svg elements and check for aria-hidden="true"
      const svgRegex = /<svg\b([^>]*)>/gi;
      let svgMatch;
      const violations = [];

      while ((svgMatch = svgRegex.exec(templateHtml)) !== null) {
        const attrs = svgMatch[1];
        if (!attrs.includes('aria-hidden="true"')) {
          const snippet = svgMatch[0].substring(0, 100);
          violations.push(`SVG missing aria-hidden="true": ${snippet}`);
        }
      }

      expect(violations).toEqual([]);
    });
  });

  // ─── GROUP 6: No duplicate selectors with conflicting values ────────
  describe('Group 6: No duplicate selectors with conflicting values', () => {
    test('same selector should not appear twice with different property values in the same file', () => {
      const violations = [];

      for (const file of allCssFiles) {
        const content = file.content;

        // Simple CSS parser: extract selector -> property: value pairs
        const selectorProps = {};
        let depth = 0;
        let currentSelector = '';
        let currentBlock = '';
        let inComment = false;

        for (let i = 0; i < content.length; i++) {
          // Handle comments
          if (!inComment && content[i] === '/' && content[i + 1] === '*') {
            inComment = true;
            i++;
            continue;
          }
          if (inComment && content[i] === '*' && content[i + 1] === '/') {
            inComment = false;
            i++;
            continue;
          }
          if (inComment) continue;

          if (content[i] === '{') {
            if (depth === 0) {
              currentSelector = currentBlock.trim();
              currentBlock = '';
            } else {
              currentBlock += content[i];
            }
            depth++;
          } else if (content[i] === '}') {
            depth--;
            if (depth === 0) {
              // We have a complete rule block
              const selector = currentSelector;
              const body = currentBlock.trim();

              // Skip @keyframes, @media, etc.
              if (!selector.startsWith('@')) {
                const props = {};
                const declarations = body.split(';').filter(Boolean);
                for (const decl of declarations) {
                  const colonIdx = decl.indexOf(':');
                  if (colonIdx === -1) continue;
                  const prop = decl.substring(0, colonIdx).trim();
                  const val = decl.substring(colonIdx + 1).trim();
                  if (prop && val && !prop.includes('{') && !prop.includes('}')) {
                    props[prop] = val;
                  }
                }

                if (Object.keys(props).length > 0) {
                  if (selectorProps[selector]) {
                    // Check for conflicting property values
                    for (const [prop, val] of Object.entries(props)) {
                      if (selectorProps[selector][prop] && selectorProps[selector][prop] !== val) {
                        violations.push(
                          `${file.name}: selector "${selector}" has conflicting values for "${prop}": ` +
                          `"${selectorProps[selector][prop]}" vs "${val}"`
                        );
                      }
                    }
                    // Merge
                    Object.assign(selectorProps[selector], props);
                  } else {
                    selectorProps[selector] = { ...props };
                  }
                }
              }

              currentBlock = '';
              currentSelector = '';
            } else {
              currentBlock += content[i];
            }
          } else {
            currentBlock += content[i];
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  // ─── GROUP 7: No cross-file selector conflicts ──────────────────────
  describe('Group 7: No cross-file selector conflicts', () => {
    let healthCss, layoutCss, componentsCss, utilitiesCss;

    beforeAll(() => {
      healthCss = fs.readFileSync(path.join(CSS_DIR, 'health.css'), 'utf8');
      layoutCss = fs.readFileSync(path.join(CSS_DIR, 'layout.css'), 'utf8');
      componentsCss = fs.readFileSync(path.join(CSS_DIR, 'components.css'), 'utf8');
      utilitiesCss = fs.readFileSync(path.join(CSS_DIR, 'utilities.css'), 'utf8');
    });

    /**
     * Helper: count how many times a top-level selector block defines a given
     * property in a CSS string.  Only counts rules NOT inside @media / @keyframes.
     */
    function countTopLevelProperty(css, selector, property) {
      let count = 0;
      let depth = 0;
      let inAtRule = false;
      let atRuleDepth = -1;
      let currentSelector = '';
      let buf = '';
      let inComment = false;

      for (let i = 0; i < css.length; i++) {
        // Comments
        if (!inComment && css[i] === '/' && css[i + 1] === '*') { inComment = true; i++; continue; }
        if (inComment && css[i] === '*' && css[i + 1] === '/') { inComment = false; i++; continue; }
        if (inComment) continue;

        if (css[i] === '{') {
          if (depth === 0) {
            const trimmed = buf.trim();
            if (trimmed.startsWith('@')) {
              inAtRule = true;
              atRuleDepth = depth;
            } else {
              currentSelector = trimmed;
            }
            buf = '';
          }
          depth++;
        } else if (css[i] === '}') {
          depth--;
          if (depth === 0) {
            if (!inAtRule && currentSelector === selector) {
              // Check if buf contains the property
              const declarations = buf.split(';');
              for (const decl of declarations) {
                const colonIdx = decl.indexOf(':');
                if (colonIdx === -1) continue;
                const prop = decl.substring(0, colonIdx).trim();
                if (prop === property) count++;
              }
            }
            buf = '';
            currentSelector = '';
            if (inAtRule && depth <= atRuleDepth) {
              inAtRule = false;
              atRuleDepth = -1;
            }
          } else if (inAtRule && depth <= atRuleDepth) {
            inAtRule = false;
            atRuleDepth = -1;
          }
        } else {
          buf += css[i];
        }
      }
      return count;
    }

    /**
     * Helper: check if a CSS string contains a given selector (exact, top-level)
     * that defines a specific property.
     */
    function hasTopLevelSelectorWithProperty(css, selector, property) {
      return countTopLevelProperty(css, selector, property) > 0;
    }

    test('Test 1: .chart-container height is defined in exactly ONE file (layout.css)', () => {
      const inHealth = hasTopLevelSelectorWithProperty(healthCss, '.chart-container', 'height');
      const inLayout = hasTopLevelSelectorWithProperty(layoutCss, '.chart-container', 'height');

      // Canonical owner is layout.css (uses JS dynamic variable)
      expect(inLayout).toBe(true);
      // Must NOT also be in health.css
      expect(inHealth).toBe(false);
    });

    test('Test 2: .status-dot width/height is defined in exactly ONE file', () => {
      const inComponents = hasTopLevelSelectorWithProperty(componentsCss, '.status-dot', 'width');
      const inUtilities = hasTopLevelSelectorWithProperty(utilitiesCss, '.status-dot', 'width');

      const filesDefining = [
        inComponents && 'components.css',
        inUtilities && 'utilities.css',
      ].filter(Boolean);

      expect(filesDefining).toHaveLength(1);
    });

    test('Test 3: .overflow-menu-trigger:hover background is defined in exactly ONE file', () => {
      const inLayout = hasTopLevelSelectorWithProperty(layoutCss, '.overflow-menu-trigger:hover', 'background');
      const inUtilities = hasTopLevelSelectorWithProperty(utilitiesCss, '.overflow-menu-trigger:hover', 'background');

      const filesDefining = [
        inLayout && 'layout.css',
        inUtilities && 'utilities.css',
      ].filter(Boolean);

      expect(filesDefining).toHaveLength(1);
    });

    test('Test 4: .heartbeat-indicator display is defined in exactly ONE file', () => {
      const inComponents = hasTopLevelSelectorWithProperty(componentsCss, '.heartbeat-indicator', 'display');
      const inHealth = hasTopLevelSelectorWithProperty(healthCss, '.heartbeat-indicator', 'display');

      const filesDefining = [
        inComponents && 'components.css',
        inHealth && 'health.css',
      ].filter(Boolean);

      expect(filesDefining).toHaveLength(1);
    });

    test('Test 5: .empty-state base styles defined in exactly ONE file', () => {
      const inHealth = hasTopLevelSelectorWithProperty(healthCss, '.empty-state', 'display');
      const inUtilities = hasTopLevelSelectorWithProperty(utilitiesCss, '.empty-state', 'display');

      const filesDefining = [
        inHealth && 'health.css',
        inUtilities && 'utilities.css',
      ].filter(Boolean);

      expect(filesDefining).toHaveLength(1);
    });

    test('Test 6: no duplicate selector blocks in same CSS file (.global-search-container in components.css)', () => {
      // Count how many times .global-search-container appears as a top-level selector in components.css
      // We count all properties from all blocks — if the selector appears more than once that's a duplicate
      let selectorBlockCount = 0;
      let depth = 0;
      let buf = '';
      let inComment = false;
      let inAtRule = false;
      let atRuleDepth = -1;

      for (let i = 0; i < componentsCss.length; i++) {
        if (!inComment && componentsCss[i] === '/' && componentsCss[i + 1] === '*') { inComment = true; i++; continue; }
        if (inComment && componentsCss[i] === '*' && componentsCss[i + 1] === '/') { inComment = false; i++; continue; }
        if (inComment) continue;

        if (componentsCss[i] === '{') {
          if (depth === 0) {
            const trimmed = buf.trim();
            if (trimmed.startsWith('@')) {
              inAtRule = true;
              atRuleDepth = depth;
            } else if (trimmed === '.global-search-container' && !inAtRule) {
              selectorBlockCount++;
            }
            buf = '';
          }
          depth++;
        } else if (componentsCss[i] === '}') {
          depth--;
          if (depth === 0) {
            buf = '';
            if (inAtRule && depth <= atRuleDepth) {
              inAtRule = false;
              atRuleDepth = -1;
            }
          }
        } else {
          buf += componentsCss[i];
        }
      }

      expect(selectorBlockCount).toBe(1);
    });
  });

  // ─── GROUP 8: tokens.css contains only tokens ───────────────────────
  describe('Group 8: tokens.css contains only tokens', () => {
    /**
     * tokens.css should contain ONLY:
     *  - CSS custom property definitions (:root, [data-theme], @media prefers-color-scheme)
     *  - Universal reset (* { ... })
     *  - Base body styles (body, body.density-*)
     *
     * It must NOT contain component-specific selectors like .model-breakdown-*,
     * .routing-disabled-*, .welcome-*, .routing-toggle-*, etc.
     */

    // Selectors that are ALLOWED in tokens.css (token definitions + reset/base)
    const ALLOWED_SELECTOR_PATTERNS = [
      /^:root$/,
      /^\[data-theme/,
      /^:root:not\(/,
      /^\*$/,
      /^body$/,
      /^body\.density-/,
    ];

    // Component selector patterns that must NOT appear in tokens.css
    const FORBIDDEN_COMPONENT_PATTERNS = [
      /\.model-breakdown/,
      /\.routing-disabled/,
      /\.welcome-/,
      /\.routing-toggle/,
    ];

    /**
     * Extract all top-level CSS selectors from a CSS string.
     * Skips @-rules (they are allowed), CSS variable definitions inside :root, etc.
     */
    function extractTopLevelSelectors(css) {
      const selectors = [];
      let depth = 0;
      let buf = '';
      let inComment = false;

      for (let i = 0; i < css.length; i++) {
        if (!inComment && css[i] === '/' && css[i + 1] === '*') { inComment = true; i++; continue; }
        if (inComment && css[i] === '*' && css[i + 1] === '/') { inComment = false; i++; continue; }
        if (inComment) continue;

        if (css[i] === '{') {
          if (depth === 0) {
            const trimmed = buf.trim();
            // Skip @-rules (media queries, keyframes, etc.)
            if (trimmed && !trimmed.startsWith('@')) {
              selectors.push(trimmed);
            }
            buf = '';
          }
          depth++;
        } else if (css[i] === '}') {
          depth--;
          if (depth === 0) {
            buf = '';
          }
        } else {
          if (depth === 0) {
            buf += css[i];
          }
        }
      }
      return selectors;
    }

    test('Test 1: tokens.css contains no component selectors', () => {
      const selectors = extractTopLevelSelectors(tokensCss);
      const violations = [];

      for (const selector of selectors) {
        for (const pattern of FORBIDDEN_COMPONENT_PATTERNS) {
          if (pattern.test(selector)) {
            violations.push(`Forbidden component selector in tokens.css: "${selector}"`);
          }
        }
      }

      expect(violations).toEqual([]);
    });

    test('Test 2: tokens.css selectors are limited to reset/base styles', () => {
      const selectors = extractTopLevelSelectors(tokensCss);
      const componentSelectors = [];

      for (const selector of selectors) {
        const isAllowed = ALLOWED_SELECTOR_PATTERNS.some(p => p.test(selector));
        if (!isAllowed) {
          componentSelectors.push(selector);
        }
      }

      // tokens.css should have fewer than 5 non-reset/non-base selectors
      // Ideally 0, but we allow a small threshold for edge cases
      expect(componentSelectors.length).toBeLessThan(5);

      // Also assert specific forbidden patterns are absent
      for (const sel of componentSelectors) {
        for (const pattern of FORBIDDEN_COMPONENT_PATTERNS) {
          expect(sel).not.toMatch(pattern);
        }
      }
    });
  });
});
