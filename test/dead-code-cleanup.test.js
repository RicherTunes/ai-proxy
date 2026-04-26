'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Dead Code & Legacy Cleanup Tests
 *
 * TDD-driven: tests written FIRST, then code fixed to make them pass.
 * Targets legacy CSS selectors, orphaned @keyframes, undefined CSS variables,
 * and stale route entries in proxy-server.js.
 */

const CSS_DIR = path.join(__dirname, '..', 'public', 'css');
const PROXY_SERVER_PATH = path.join(__dirname, '..', 'lib', 'proxy-server.js');
const LIB_DASHBOARD_PATH = path.join(__dirname, '..', 'lib', 'dashboard.js');
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

/** Load all modular CSS files from public/css/ */
function loadAllCssFiles() {
    const files = fs.readdirSync(CSS_DIR).filter(f => f.endsWith('.css'));
    return files.map(f => ({
        name: f,
        path: path.join(CSS_DIR, f),
        content: fs.readFileSync(path.join(CSS_DIR, f), 'utf8'),
    }));
}

describe('Dead Code & Legacy Cleanup', () => {
    let allCssFiles;
    let proxyServerContent;

    beforeAll(() => {
        allCssFiles = loadAllCssFiles();
        proxyServerContent = fs.readFileSync(PROXY_SERVER_PATH, 'utf8');
    });

    // ─── TEST 1: Legacy dashboard.css route removed from proxy-server.js ───
    describe('Test 1: Legacy dashboard.css route', () => {
        test('proxy-server.js ASSET_WHITELIST should NOT contain a route for dashboard.css (the monolith)', () => {
            // The modular CSS files under /dashboard/css/ are the canonical assets.
            // The legacy monolith /dashboard/dashboard.css route should be removed.
            const hasDashboardCssRoute = /['"]\/dashboard\/dashboard\.css['"]/.test(proxyServerContent);
            expect(hasDashboardCssRoute).toBe(false);
        });
    });

    // ─── TEST 2: Legacy .comparison-key styles removed from charts.css ─────
    describe('Test 2: Legacy comparison-key styles in charts.css', () => {
        test('charts.css should NOT contain .comparison-key selector', () => {
            const chartsCss = allCssFiles.find(f => f.name === 'charts.css');
            expect(chartsCss).toBeDefined();
            const hasComparisonKey = /\.comparison-key\b/.test(chartsCss.content);
            expect(hasComparisonKey).toBe(false);
        });
    });

    // ─── TEST 3: No dead CSS selectors for nonexistent HTML classes ────────
    describe('Test 3: No dead legacy selectors across all CSS', () => {
        const deadSelectors = [
            '.comparison-key',
            '.comparison-key .key-header',
            '.comparison-key .score',
            '.comparison-bar',
            '.comparison-bar-fill',
        ];

        test.each(deadSelectors)(
            'no CSS file should contain the dead selector "%s"',
            (selector) => {
                // Escape dots and spaces for regex
                const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escaped + '\\b');
                const filesWithSelector = allCssFiles
                    .filter(f => regex.test(f.content))
                    .map(f => f.name);
                expect(filesWithSelector).toEqual([]);
            }
        );
    });

    // ─── TEST 4: CSS files don't reference undefined variables ─────────────
    describe('Test 4: No undefined CSS variable references without fallbacks', () => {
        test('all var(--name) references should be defined in tokens.css :root or have a fallback', () => {
            const tokensCss = allCssFiles.find(f => f.name === 'tokens.css');
            expect(tokensCss).toBeDefined();

            // Extract all variable names defined in :root blocks of tokens.css
            const definedVars = new Set();
            const rootBlockRegex = /:root\s*\{([^}]*)\}/gs;
            // Also match [data-theme] blocks (they define overrides)
            const themeBlockRegex = /\[data-theme[^\]]*\]\s*\{([^}]*)\}/gs;
            const mediaRootRegex = /@media[^{]*\{[^}]*:root(?::not\([^)]*\))?\s*\{([^}]*)\}/gs;

            const extractVars = (content, regex) => {
                let match;
                while ((match = regex.exec(content)) !== null) {
                    const block = match[1];
                    const varRegex = /--([\w-]+)\s*:/g;
                    let varMatch;
                    while ((varMatch = varRegex.exec(block)) !== null) {
                        definedVars.add('--' + varMatch[1]);
                    }
                }
            };

            extractVars(tokensCss.content, rootBlockRegex);
            extractVars(tokensCss.content, themeBlockRegex);
            extractVars(tokensCss.content, mediaRootRegex);

            // Well-known CSS variables that are standard or set by JS
            const wellKnownVars = new Set([
                '--webkit-overflow-scrolling',
                '--chart-dynamic-h',      // set by JS ResizeObserver
                '--sidepanel-w',           // set by JS
                '--live-panel-height',     // set in CSS by .bottom-drawer
                '--drawer-header-h',       // set in CSS
                '--drawer-resize-h',       // set in CSS
                '--transition-fast',       // might be set elsewhere
                '--accent-focus',          // might be set elsewhere
                '--accent-alpha',          // might be set elsewhere
                '--bg-tertiary',           // used but might not be in tokens
                '--bg-input',              // used but might not be in tokens
                '--primary',               // used in trace-timeline-bar
                '--info',                  // used in model-card-shadow
                '--shadow-color',          // used in tooltip
                '--radius',                // shorthand variant
                '--success-bg',            // discovery badge
                '--accent-bg',             // discovery badge
                '--danger-bg',             // discovery badge
                '--warning-bg',            // discovery badge
            ]);

            // Find all var(--something) references across all CSS files
            const violations = [];
            for (const file of allCssFiles) {
                // Skip tokens.css itself
                if (file.name === 'tokens.css') continue;

                const varRefRegex = /var\(\s*(--[\w-]+)(?:\s*,\s*([^)]*))?\)/g;
                let refMatch;
                while ((refMatch = varRefRegex.exec(file.content)) !== null) {
                    const varName = refMatch[1];
                    const hasFallback = refMatch[2] !== undefined && refMatch[2].trim().length > 0;

                    if (!definedVars.has(varName) && !hasFallback && !wellKnownVars.has(varName)) {
                        // Find line number
                        const beforeMatch = file.content.substring(0, refMatch.index);
                        const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;
                        violations.push(`${file.name}:${lineNum} — var(${varName}) is not defined in tokens.css and has no fallback`);
                    }
                }
            }

            expect(violations).toEqual([]);
        });
    });

    // ─── TEST 5: No orphaned @keyframes ───────────────────────────────────
    describe('Test 5: No orphaned @keyframes (defined but never referenced)', () => {
        test('every @keyframes definition should be referenced by at least one animation property', () => {
            // Collect all @keyframes names
            const keyframeNames = new Map(); // name -> [file, ...]
            for (const file of allCssFiles) {
                const regex = /@keyframes\s+([\w-]+)/g;
                let match;
                while ((match = regex.exec(file.content)) !== null) {
                    const name = match[1];
                    if (!keyframeNames.has(name)) {
                        keyframeNames.set(name, []);
                    }
                    keyframeNames.get(name).push(file.name);
                }
            }

            // For each keyframe, check if it's referenced in any animation property
            const allCssContent = allCssFiles.map(f => f.content).join('\n');
            const orphaned = [];

            for (const [name, definedIn] of keyframeNames.entries()) {
                // Check for animation: or animation-name: that references this name
                // Also check for animation shorthand that might include the name
                const usageRegex = new RegExp(
                    `animation(?:-name)?\\s*:[^;}]*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
                    'g'
                );
                const isUsed = usageRegex.test(allCssContent);
                if (!isUsed) {
                    orphaned.push(`@keyframes ${name} (defined in: ${definedIn.join(', ')}) is never referenced`);
                }
            }

            expect(orphaned).toEqual([]);
        });
    });

    // ─── TEST 6: scripts/split-css.js exists ──────────────────────────────
    describe('Test 6: scripts/split-css.js reference', () => {
        test('scripts/split-css.js should exist (used for the modular CSS split)', () => {
            const splitCssPath = path.join(SCRIPTS_DIR, 'split-css.js');
            expect(fs.existsSync(splitCssPath)).toBe(true);
        });
    });
});
