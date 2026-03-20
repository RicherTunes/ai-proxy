/**
 * Theme Consistency Tests
 *
 * TDD-driven tests to ensure the GLM Proxy Dashboard maintains consistent
 * theming between dark (:root) and light ([data-theme="light"]) modes.
 *
 * Groups:
 * 1. All CSS variables defined in both themes
 * 2. No raw color values outside tokens.css
 * 3. Hardcoded white/black text
 * 4. Light theme overrides for color-dependent components
 * 5. Theme toggle functionality
 * 6. prefers-color-scheme media query
 */

const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', 'public', 'css');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Read all CSS files once
let tokensCss;
let allCssFiles; // all CSS files except tokens.css
let allCssContent; // concatenated content of all CSS files except tokens.css
let allCssContentIncludingTokens; // everything
let dashboardHtml;

beforeAll(() => {
    tokensCss = fs.readFileSync(path.join(CSS_DIR, 'tokens.css'), 'utf8');

    const cssFileNames = [
        'components.css', 'health.css', 'routing.css',
        'layout.css', 'utilities.css', 'charts.css', 'requests.css'
    ];

    allCssFiles = {};
    for (const name of cssFileNames) {
        const filePath = path.join(CSS_DIR, name);
        if (fs.existsSync(filePath)) {
            allCssFiles[name] = fs.readFileSync(filePath, 'utf8');
        }
    }

    // Also include dashboard.css from public root
    const dashboardCssPath = path.join(PUBLIC_DIR, 'dashboard.css');
    if (fs.existsSync(dashboardCssPath)) {
        allCssFiles['dashboard.css'] = fs.readFileSync(dashboardCssPath, 'utf8');
    }

    // Also include public/dashboard/css/routing.css (separate routing page)
    const routingDashCssPath = path.join(PUBLIC_DIR, 'dashboard', 'css', 'routing.css');
    if (fs.existsSync(routingDashCssPath)) {
        allCssFiles['dashboard-routing.css'] = fs.readFileSync(routingDashCssPath, 'utf8');
    }

    allCssContent = Object.values(allCssFiles).join('\n');
    allCssContentIncludingTokens = tokensCss + '\n' + allCssContent;

    // Read dashboard HTML
    const { generateDashboard } = require('../lib/dashboard');
    dashboardHtml = generateDashboard();
});

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extract CSS variable names from a specific block in CSS text.
 * @param {string} css - raw CSS text
 * @param {string} selectorPattern - regex pattern for the selector (e.g., ':root')
 * @returns {string[]} list of variable names like '--bg-primary'
 */
function extractVarsFromBlock(css, selectorPattern) {
    // Match the block: selector { ... }
    const blockRegex = new RegExp(selectorPattern + '\\s*\\{([^}]+)\\}', 'g');
    const vars = [];
    let match;
    while ((match = blockRegex.exec(css)) !== null) {
        const body = match[1];
        const varRegex = /(--[\w-]+)\s*:/g;
        let varMatch;
        while ((varMatch = varRegex.exec(body)) !== null) {
            vars.push(varMatch[1]);
        }
    }
    return [...new Set(vars)];
}

/**
 * Determine if a variable name is theme-invariant (doesn't change between themes).
 * These are spacing, radius, font, z-index, dimension, and motion tokens.
 */
function isThemeInvariant(varName) {
    const invariantPrefixes = [
        '--spacing-', '--radius-', '--font-', '--z-',
        '--gap-', '--padding-', '--dur', '--ease',
        '--drawer-', '--dock-', '--header-', '--search-',
        '--touch-', '--font-body', '--font-mono', '--font-heading'
    ];
    return invariantPrefixes.some(prefix => varName.startsWith(prefix));
}

// ── GROUP 1: All CSS variables defined in both themes ────────────────────

describe('Group 1: CSS variables defined in both themes', () => {
    let rootVars;
    let lightVars;

    beforeAll(() => {
        rootVars = extractVarsFromBlock(tokensCss, ':root');
        lightVars = extractVarsFromBlock(tokensCss, '\\[data-theme="light"\\]');
    });

    test('should have :root variables defined', () => {
        expect(rootVars.length).toBeGreaterThan(10);
    });

    test('should have [data-theme="light"] variables defined', () => {
        expect(lightVars.length).toBeGreaterThan(5);
    });

    test('every semantic color/background/border variable in :root should also be in [data-theme="light"]', () => {
        // Filter to only semantic variables that should differ between themes
        const semanticVars = rootVars.filter(v => !isThemeInvariant(v));

        const missingInLight = semanticVars.filter(v => !lightVars.includes(v));

        // Report missing variables clearly
        if (missingInLight.length > 0) {
            // These are the ones we need to check - some may legitimately not need overrides
            // Color-related variables that MUST have light theme equivalents:
            const colorRelated = missingInLight.filter(v =>
                /^--(bg-|text-|accent|success|warning|error|danger|border|glow-|color-|score-|chip-|token-color|surface-|border-subtle)/.test(v)
            );

            expect(colorRelated).toEqual([]);
        }
    });

    test('light theme should not define variables absent from :root', () => {
        const extraInLight = lightVars.filter(v => !rootVars.includes(v));
        expect(extraInLight).toEqual([]);
    });
});

// ── GROUP 2: No raw color values outside tokens.css ──────────────────────

describe('Group 2: No raw token color values outside tokens.css', () => {
    // These are the exact hex values defined as token colors in :root.
    // They should NOT appear as standalone color values in other CSS files.
    const tokenColors = {
        '#0a0e1a': '--bg-primary (dark)',
        '#141b2d': '--bg-secondary (dark)',
        '#1e293b': '--bg-card (dark)',
        '#e2e8f0': '--text-primary (dark) / --border (light)',
        '#94a3b8': '--text-secondary (dark)',
        '#64748b': '--text-secondary (light)',
        '#334155': '--border (dark)',
    };

    for (const [hex, tokenName] of Object.entries(tokenColors)) {
        test(`should not use raw ${hex} (${tokenName}) outside tokens.css`, () => {
            // Match standalone hex color usage — not inside rgba(), not in
            // CSS variable definitions (:root blocks), and not as var() fallbacks.
            const lines = allCssContent.split('\n');
            const violations = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmed = line.trim();
                // Skip lines that are inside rgba() — these are opacity variants
                if (line.includes('rgba(')) continue;
                // Skip comment lines
                if (trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
                // Skip CSS variable definitions (--var-name: #hex) — these are token definitions
                if (/^\s*--[\w-]+\s*:/.test(line)) continue;
                // Skip var() fallback patterns like var(--border, #334155)
                if (line.includes('var(') && line.includes(hex)) continue;

                // Check for the hex color as a standalone value
                // Must be preceded by : or space and followed by ; or space or end
                const hexRegex = new RegExp(`(?::|\\s)${hex.replace('#', '#')}(?:\\s|;|\\)|,|$)`, 'i');
                if (hexRegex.test(line)) {
                    violations.push(`Line ${i + 1}: ${trimmed}`);
                }
            }

            expect(violations).toEqual([]);
        });
    }
});

// ── GROUP 3: Hardcoded white/black text ──────────────────────────────────

describe('Group 3: Hardcoded white/black text colors', () => {
    test('should have fewer than 75 instances of hardcoded color: white/#fff/#ffffff', () => {
        // Many of these are legitimate: white text on colored badges, buttons, and
        // status indicators. The threshold guards against unchecked growth.
        // Current baseline: ~68 instances. If this grows, each new use should
        // ideally use var(--text-on-accent) or a similar token instead.
        const lines = allCssContentIncludingTokens.split('\n');
        const whiteLiterals = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // Skip comments
            if (line.startsWith('/*') || line.startsWith('*')) continue;
            // Skip lines that are defining the --text-on-accent variable
            if (line.includes('--text-on-accent')) continue;

            // Match: color: white, color: #fff, color: #ffffff
            if (/color\s*:\s*(white|#fff(?:fff)?)\s*[;!]/.test(line)) {
                whiteLiterals.push(`Line ${i + 1}: ${line}`);
            }
        }

        // Threshold set just above current baseline to catch growth
        expect(whiteLiterals.length).toBeLessThan(75);
    });

    test('should have fewer than 15 instances of hardcoded color: black/#000/#000000', () => {
        // Some black text is legitimate on colored backgrounds (warning banners,
        // badges with colored backgrounds like .btn-success, .paused-banner).
        // Current baseline: ~12 instances.
        const lines = allCssContentIncludingTokens.split('\n');
        const blackLiterals = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('/*') || line.startsWith('*')) continue;

            if (/color\s*:\s*(black|#000(?:000)?)\s*[;!]/.test(line)) {
                blackLiterals.push(`Line ${i + 1}: ${line}`);
            }
        }

        expect(blackLiterals.length).toBeLessThan(15);
    });

    test('should count total hardcoded white as standalone color values (audit)', () => {
        // Broader check: any `color: white` or `color: #fff` across all files
        const whiteMatches = allCssContent.match(/color\s*:\s*(?:white|#fff(?:fff)?)\b/gi) || [];

        // This is an audit — just log the count. The threshold is the important test above.
        expect(whiteMatches).toBeDefined();
    });
});

// ── GROUP 4: Light theme overrides for color-dependent components ────────

describe('Group 4: Light theme overrides for color-dependent components', () => {
    test('components.css should have [data-theme="light"] overrides', () => {
        const componentsCss = allCssFiles['components.css'] || '';
        const hasLightOverrides = componentsCss.includes('[data-theme="light"]');
        expect(hasLightOverrides).toBe(true);
    });

    test('tier badges should have light theme contrast overrides', () => {
        // The tier-badge-light and tier-badge-medium should have light theme overrides
        // to ensure WCAG AA contrast on light backgrounds
        const componentsCss = allCssFiles['components.css'] || '';
        expect(componentsCss).toContain('[data-theme="light"] .tier-badge-light');
        expect(componentsCss).toContain('[data-theme="light"] .tier-badge-medium');
    });

    test('toast shadow should have light theme override', () => {
        const componentsCss = allCssFiles['components.css'] || '';
        expect(componentsCss).toContain('[data-theme="light"] .toast');
    });

    test('analytics table hover should have light theme override', () => {
        const componentsCss = allCssFiles['components.css'] || '';
        expect(componentsCss).toContain('[data-theme="light"] .analytics-table');
    });

    test('issues panel should have light theme shadow override', () => {
        const healthCss = allCssFiles['health.css'] || '';
        expect(healthCss).toContain('[data-theme="light"] .issues-panel');
    });

    test('filter input should have light theme override in requests.css', () => {
        const requestsCss = allCssFiles['requests.css'] || '';
        expect(requestsCss).toContain('[data-theme="light"]');
    });

    test('traces table hover should have light theme override', () => {
        const requestsCss = allCssFiles['requests.css'] || '';
        expect(requestsCss).toContain('[data-theme="light"] .traces-table');
    });
});

// ── GROUP 5: Theme toggle doesn't break layout ──────────────────────────

describe('Group 5: Theme toggle infrastructure', () => {
    test('theme toggle button should exist in dashboard HTML', () => {
        expect(dashboardHtml).toContain('theme-toggle');
    });

    test('dashboard JS should handle theme switching', () => {
        const dashboardJs = fs.readFileSync(
            path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8'
        );
        // Should set data-theme attribute
        expect(dashboardJs).toContain('data-theme');
    });

    test('dashboard JS should persist theme choice in localStorage', () => {
        const dashboardJs = fs.readFileSync(
            path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8'
        );
        expect(dashboardJs).toContain('localStorage');
        // Should save and read theme preference
        expect(dashboardJs).toMatch(/localStorage\.(get|set)Item/);
    });

    test('tokens.css should define [data-theme="light"] selector', () => {
        expect(tokensCss).toContain('[data-theme="light"]');
    });
});

// ── GROUP 6: prefers-color-scheme media query ────────────────────────────

describe('Group 6: prefers-color-scheme auto-detection', () => {
    test('should have @media (prefers-color-scheme) query for auto-detecting OS preference', () => {
        // tokens.css should have prefers-color-scheme media query
        // to auto-detect OS dark/light preference
        expect(tokensCss).toContain('prefers-color-scheme');
        expect(tokensCss).toContain('prefers-color-scheme: light');
    });

    test('should have prefers-reduced-motion support (accessibility)', () => {
        // This IS required — verify it exists
        expect(allCssContentIncludingTokens).toContain('prefers-reduced-motion');
    });
});

// ── GROUP 7: Hardcoded rgba with dark-theme colors in component CSS ──────

describe('Group 7: Hardcoded rgba backgrounds that may need light overrides', () => {
    test('should audit rgba-based backgrounds in components.css', () => {
        const componentsCss = allCssFiles['components.css'] || '';
        // Find all rgba(...) background declarations
        const rgbaBackgrounds = componentsCss.match(/background\s*:\s*rgba\([^)]+\)/g) || [];

        // This is informational — we expect some rgba backgrounds
        // The important thing is that the ones with dark-optimized colors
        // have light-theme counterparts
        expect(rgbaBackgrounds.length).toBeGreaterThan(0);
    });

    test('model-breakdown-table td border should use theme-aware color, not hardcoded rgba', () => {
        // .model-breakdown-table td previously used rgba(51, 65, 85, 0.3) which is
        // #334155 (dark border color) with alpha. This is invisible in light theme.
        // It should use color-mix or var(--border) instead.
        expect(tokensCss).toContain('.model-breakdown-table td');
        // Should NOT contain the hardcoded dark rgba
        expect(tokensCss).not.toMatch(/\.model-breakdown-table td[\s\S]*?rgba\(51,\s*65,\s*85/);
        // Should use a theme-aware approach
        expect(tokensCss).toMatch(/\.model-breakdown-table td[\s\S]*?(?:var\(--border\)|color-mix)/);
    });

    test('filter-chip active state uses hardcoded accent rgba', () => {
        const componentsCss = allCssFiles['components.css'] || '';
        // .filter-chip.active uses rgba(6, 182, 212, 0.15) - this is fine for both themes
        // since it's just accent with alpha. Verify it exists.
        const hasFilterChipActive = componentsCss.includes('.filter-chip.active');
        expect(hasFilterChipActive).toBe(true);
    });
});
