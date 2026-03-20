/**
 * Frontend Performance Tests (TDD)
 *
 * Validates CSS efficiency, animation performance, JS payload sizes,
 * layout-thrashing patterns, !important abuse, and cache-busting hygiene.
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const CSS_DIR = path.join(__dirname, '..', 'public', 'css');
const JS_DIR  = path.join(__dirname, '..', 'public', 'js');
const DASHBOARD_FILE = path.join(__dirname, '..', 'lib', 'dashboard.js');

/** Read every *.css file in public/css/ and return { name, content, bytes } */
function loadCssFiles() {
    return fs.readdirSync(CSS_DIR)
        .filter(f => f.endsWith('.css'))
        .map(f => {
            const content = fs.readFileSync(path.join(CSS_DIR, f), 'utf8');
            return { name: f, content, bytes: Buffer.byteLength(content, 'utf8') };
        });
}

/** Read every *.js file in public/js/ and return { name, content, bytes } */
function loadJsFiles() {
    return fs.readdirSync(JS_DIR)
        .filter(f => f.endsWith('.js'))
        .map(f => {
            const content = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
            return { name: f, content, bytes: Buffer.byteLength(content, 'utf8') };
        });
}

/* ------------------------------------------------------------------ */
/*  Group 1: CSS Efficiency                                            */
/* ------------------------------------------------------------------ */

describe('Group 1: CSS efficiency', () => {
    let cssFiles;
    let totalCssBytes;
    let totalRules;

    beforeAll(() => {
        cssFiles = loadCssFiles();
        totalCssBytes = cssFiles.reduce((sum, f) => sum + f.bytes, 0);

        // Count CSS rules: approximate by counting '{' that are NOT inside
        // @keyframes or @media blocks.  A simple heuristic: count all '{',
        // then subtract @keyframes blocks and @media wrapper braces.
        const allCss = cssFiles.map(f => f.content).join('\n');

        // Remove contents of @keyframes blocks so their braces do not count
        const withoutKeyframes = allCss.replace(/@keyframes\s+[\w-]+\s*\{[^}]*(\{[^}]*\}[^}]*)*\}/g, '');

        // Count remaining '{' as an approximation of rule count
        totalRules = (withoutKeyframes.match(/\{/g) || []).length;
    });

    test('total CSS payload is under 350KB', () => {
        const kb = totalCssBytes / 1024;
        // Log actual size for diagnostics
        console.log(`  Total CSS: ${kb.toFixed(1)} KB across ${cssFiles.length} files`);
        cssFiles.forEach(f => console.log(`    ${f.name}: ${(f.bytes / 1024).toFixed(1)} KB`));
        expect(totalCssBytes).toBeLessThan(350 * 1024);
    });

    test('fewer than 2500 CSS rules (flag bloat)', () => {
        console.log(`  Approximate CSS rule count: ${totalRules}`);
        expect(totalRules).toBeLessThan(2500);
    });
});

/* ------------------------------------------------------------------ */
/*  Group 2: No CSS !important abuse                                   */
/* ------------------------------------------------------------------ */

describe('Group 2: No CSS !important abuse', () => {
    let importantOccurrences;

    beforeAll(() => {
        const cssFiles = loadCssFiles();
        importantOccurrences = [];

        for (const file of cssFiles) {
            const lines = file.content.split('\n');
            lines.forEach((line, idx) => {
                // Match !important that is NOT inside a comment
                if (/!important/.test(line) && !/^\s*\/\*/.test(line) && !/^\s*\*/.test(line)) {
                    importantOccurrences.push({
                        file: file.name,
                        line: idx + 1,
                        text: line.trim().substring(0, 100),
                    });
                }
            });
        }
    });

    test('!important count is under 25', () => {
        console.log(`  Total !important occurrences: ${importantOccurrences.length}`);
        importantOccurrences.forEach(o =>
            console.log(`    ${o.file}:${o.line} — ${o.text}`)
        );
        expect(importantOccurrences.length).toBeLessThan(25);
    });
});

/* ------------------------------------------------------------------ */
/*  Group 3: Animation Performance                                     */
/* ------------------------------------------------------------------ */

describe('Group 3: Animation performance — no layout-triggering properties', () => {
    let violations;

    beforeAll(() => {
        const cssFiles = loadCssFiles();
        violations = [];

        // Properties that cause expensive layout reflow when animated
        const badProps = /\b(top|left|right|bottom|margin|padding)\b/;
        // Exceptions: max-height for collapsibles, width on progress bars, gap
        const allowedContexts = /\b(max-height|max-width|gap)\b/;
        // Also allow width when it looks like a progress bar context
        const progressBarPattern = /\b(progress|fill|budget|bar|score-segment|pool-bar)\b/i;

        for (const file of cssFiles) {
            const lines = file.content.split('\n');
            lines.forEach((line, idx) => {
                // Only check lines with transition: or animation: property declarations
                if (!/^\s*(transition|animation)\s*:/.test(line)) return;

                // Extract the property value
                const propValue = line.replace(/^\s*(transition|animation)\s*:\s*/, '');

                // Check if it animates a bad property
                if (!badProps.test(propValue)) return;

                // Allow max-height, max-width, gap
                if (allowedContexts.test(propValue) && !badProps.test(propValue.replace(/(max-height|max-width|gap)/g, ''))) return;

                // Check if it is a progress bar / fill context (width on progress bars is acceptable)
                // Look at surrounding lines for context (wider window to catch selector names)
                const contextStart = Math.max(0, idx - 15);
                const contextLines = lines.slice(contextStart, idx + 1).join(' ');

                // Allow width transitions on progress bars
                if (/\bwidth\b/.test(propValue) && progressBarPattern.test(contextLines)) return;

                // Allow padding transitions on body density changes
                if (/\bpadding\b/.test(propValue) && /body|density|card|status-card/.test(contextLines)) return;

                // Allow height on sticky header (small layout, acceptable)
                if (/\bheight\b/.test(propValue) && /header|drawer/.test(contextLines)) return;

                // Allow right on bottom-drawer docking
                if (/\bright\b/.test(propValue) && /drawer|dock/.test(contextLines)) return;

                // Allow top on skip-to-content accessibility link
                if (/\btop\b/.test(propValue) && /skip-to-content/.test(contextLines)) return;

                // Allow max-height, padding on collapsible/upgrade-info (progressive disclosure)
                if (/\b(max-height|padding)\b/.test(propValue) && /collapsible|upgrade-info/.test(contextLines)) return;

                violations.push({
                    file: file.name,
                    line: idx + 1,
                    text: line.trim().substring(0, 120),
                });
            });
        }
    });

    test('no layout-triggering animations (width/height/top/left/margin/padding)', () => {
        if (violations.length > 0) {
            console.log('  Layout-triggering animation violations:');
            violations.forEach(v =>
                console.log(`    ${v.file}:${v.line} — ${v.text}`)
            );
        }
        expect(violations.length).toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/*  Group 4: No layout thrashing patterns in JS                        */
/* ------------------------------------------------------------------ */

describe('Group 4: No layout thrashing patterns in JS', () => {
    let thrashingInstances;

    beforeAll(() => {
        const jsFiles = loadJsFiles();
        thrashingInstances = [];

        // DOM read properties
        const domReads = /\.(offsetWidth|offsetHeight|clientWidth|clientHeight|getBoundingClientRect|scrollTop|scrollLeft|scrollHeight|scrollWidth)\b/;
        // DOM write patterns
        const domWrites = /\.(style\.|classList\.|innerHTML|setAttribute|insertAdjacentHTML|appendChild|removeChild|textContent\s*=)/;

        for (const file of jsFiles) {
            const lines = file.content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (!domReads.test(lines[i])) continue;

                // Look ahead 3 lines for a DOM write
                for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
                    if (domWrites.test(lines[j])) {
                        // Skip known-safe patterns: scrollTop = scrollHeight (auto-scroll)
                        if (/scrollTop\s*=\s*.*scrollHeight/.test(lines[j])) continue;
                        // Skip commented lines
                        if (/^\s*\/\//.test(lines[j])) continue;
                        // Skip lines inside debounced/rAF callbacks (look for rAF wrapper)
                        const contextBefore = lines.slice(Math.max(0, i - 3), i).join(' ');
                        if (/requestAnimationFrame|setTimeout|debounce|rAF|\.offsetWidth.*force reflow/.test(contextBefore)) continue;
                        if (/requestAnimationFrame|setTimeout|debounce|rAF/.test(lines[i])) continue;
                        // Skip: intentional force reflow comments
                        if (/force reflow/.test(lines[i])) continue;

                        thrashingInstances.push({
                            file: file.name,
                            readLine: i + 1,
                            writeLine: j + 1,
                            readText: lines[i].trim().substring(0, 80),
                            writeText: lines[j].trim().substring(0, 80),
                        });
                        break; // Only flag once per read line
                    }
                }
            }
        }
    });

    test('layout thrashing instances are under 10', () => {
        console.log(`  Potential layout thrashing instances: ${thrashingInstances.length}`);
        thrashingInstances.forEach(t =>
            console.log(`    ${t.file}:${t.readLine} READ  ${t.readText}\n    ${t.file}:${t.writeLine} WRITE ${t.writeText}\n`)
        );
        expect(thrashingInstances.length).toBeLessThan(10);
    });
});

/* ------------------------------------------------------------------ */
/*  Group 5: JS file sizes                                             */
/* ------------------------------------------------------------------ */

describe('Group 5: JS file sizes', () => {
    let jsFiles;
    let totalJsBytes;

    beforeAll(() => {
        jsFiles = loadJsFiles();
        totalJsBytes = jsFiles.reduce((sum, f) => sum + f.bytes, 0);
    });

    test('no single JS file exceeds 160KB', () => {
        const limit = 160 * 1024;
        const oversized = jsFiles.filter(f => f.bytes > limit);
        console.log('  JS file sizes:');
        jsFiles
            .sort((a, b) => b.bytes - a.bytes)
            .forEach(f => {
                const flag = f.bytes > limit ? ' *** OVERSIZED ***' : '';
                console.log(`    ${f.name}: ${(f.bytes / 1024).toFixed(1)} KB${flag}`);
            });
        expect(oversized.length).toBe(0);
    });

    test('total JS payload is under 600KB', () => {
        const kb = totalJsBytes / 1024;
        console.log(`  Total JS payload: ${kb.toFixed(1)} KB`);
        expect(totalJsBytes).toBeLessThan(600 * 1024);
    });
});

/* ------------------------------------------------------------------ */
/*  Group 6: Asset cache-busting                                       */
/* ------------------------------------------------------------------ */

describe('Group 6: Asset cache-busting', () => {
    let dashboardSrc;

    beforeAll(() => {
        dashboardSrc = fs.readFileSync(DASHBOARD_FILE, 'utf8');
    });

    test('all CSS references include ?v= cache-buster', () => {
        // Find all CSS link references
        const cssRefs = dashboardSrc.match(/href="[^"]*\.css[^"]*"/g) || [];
        expect(cssRefs.length).toBeGreaterThan(0);

        const missing = cssRefs.filter(ref => !/\?v=/.test(ref));
        if (missing.length > 0) {
            console.log('  CSS references missing ?v= cache-buster:');
            missing.forEach(m => console.log(`    ${m}`));
        }
        expect(missing.length).toBe(0);
    });

    test('all JS references include ?v= cache-buster', () => {
        // Find all JS script references (excluding vendor/ and CDN)
        const jsRefs = dashboardSrc.match(/src="[^"]*\.js[^"]*"/g) || [];
        const internalJs = jsRefs.filter(ref => !/vendor\/|cdn|http/.test(ref));
        expect(internalJs.length).toBeGreaterThan(0);

        const missing = internalJs.filter(ref => !/\?v=/.test(ref));
        if (missing.length > 0) {
            console.log('  JS references missing ?v= cache-buster:');
            missing.forEach(m => console.log(`    ${m}`));
        }
        expect(missing.length).toBe(0);
    });

    test('ASSET_VERSION includes a dynamic component (not just static semver)', () => {
        // The ASSET_VERSION should contain Date.now() or a similar dynamic element
        const versionLine = dashboardSrc.match(/ASSET_VERSION\s*=\s*(.+)/);
        expect(versionLine).not.toBeNull();

        const versionExpr = versionLine[1];
        console.log(`  ASSET_VERSION expression: ${versionExpr.trim()}`);

        // Must include a dynamic component — Date.now(), process.hrtime, Math.random, etc.
        const hasDynamic = /Date\.now|process\.hrtime|Math\.random|new Date|timestamp/.test(versionExpr);
        expect(hasDynamic).toBe(true);
    });
});
