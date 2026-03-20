/**
 * Template Quality Tests
 *
 * TDD-driven tests for HTML template quality, accessibility,
 * and best practices in the GLM Proxy Dashboard.
 *
 * Tests are written FIRST, then failures are fixed in lib/dashboard.js.
 */

const { generateDashboard } = require('../lib/dashboard');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract all occurrences of an HTML tag (self-closing or not) from a string.
 * Returns an array of the full opening-tag strings (up to the closing >).
 */
function extractTags(html, tagName) {
    // Match <tagName ... > (handles self-closing and normal tags)
    const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
    return html.match(re) || [];
}

/**
 * Check whether a tag string has a given attribute.
 */
function hasAttr(tag, attr) {
    // attr="value" or attr='value' or bare attr (boolean attribute)
    const re = new RegExp(`\\b${attr}\\b`, 'i');
    return re.test(tag);
}

/**
 * Get value of an attribute from a tag string.
 */
function getAttr(tag, attr) {
    const re = new RegExp(`${attr}=["']([^"']*)["']`, 'i');
    const m = tag.match(re);
    return m ? m[1] : null;
}

/**
 * Check if a button tag has text content (not just whitespace/icons).
 * We look at what comes after the opening tag until the next < or end.
 * For this helper we need the full HTML context — used differently.
 */
function buttonHasTextOrAriaLabel(html, buttonTag) {
    if (hasAttr(buttonTag, 'aria-label')) return true;
    if (hasAttr(buttonTag, 'title')) return true;
    // Check for text content within the button by finding the position
    const idx = html.indexOf(buttonTag);
    if (idx === -1) return false;
    const afterTag = html.substring(idx + buttonTag.length);
    const closeIdx = afterTag.indexOf('</button>');
    if (closeIdx === -1) return false;
    const content = afterTag.substring(0, closeIdx);
    // Strip HTML tags to get text
    const textContent = content.replace(/<[^>]*>/g, '').trim();
    return textContent.length > 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Template quality tests', () => {
    let html;

    beforeAll(() => {
        html = generateDashboard();
    });

    // =======================================================================
    // Group 1: Interactive element accessibility
    // =======================================================================
    describe('Group 1: Interactive element accessibility', () => {
        test('every <button> has text content, aria-label, or title', () => {
            const buttons = extractTags(html, 'button');
            expect(buttons.length).toBeGreaterThan(0);

            const failing = [];
            for (const btn of buttons) {
                if (!buttonHasTextOrAriaLabel(html, btn)) {
                    failing.push(btn.substring(0, 120));
                }
            }
            expect(failing).toEqual([]);
        });

        test('every <input> has a <label>, aria-label, or title', () => {
            const inputs = extractTags(html, 'input');
            expect(inputs.length).toBeGreaterThan(0);

            const failing = [];
            for (const inp of inputs) {
                const id = getAttr(inp, 'id');
                const type = getAttr(inp, 'type');
                // Hidden inputs don't need labels
                if (type === 'hidden') continue;
                // Checkboxes wrapped in <label> are OK — check for that
                if (type === 'checkbox') {
                    // Check if the input is wrapped in a <label> tag
                    const idx = html.indexOf(inp);
                    if (idx > -1) {
                        const before = html.substring(Math.max(0, idx - 200), idx);
                        if (before.includes('<label')) continue;
                    }
                }
                const hasLabel = hasAttr(inp, 'aria-label') || hasAttr(inp, 'title');
                const hasAssociatedLabel = id && html.includes(`for="${id}"`);
                if (!hasLabel && !hasAssociatedLabel) {
                    // Check if input has placeholder (we will flag these separately in Group 5)
                    // For this test, having placeholder is not enough — but we allow it as partial
                    failing.push(inp.substring(0, 120));
                }
            }
            expect(failing).toEqual([]);
        });

        test('every role="tab" element has aria-controls', () => {
            const tabs = extractTags(html, '(?:button|div|a)').filter(t =>
                /role=["']tab["']/i.test(t)
            );
            // Also just search for all role="tab" in the html
            const roleTabRe = /<[^>]+role=["']tab["'][^>]*>/gi;
            const allTabs = html.match(roleTabRe) || [];
            expect(allTabs.length).toBeGreaterThan(0);

            const failing = [];
            for (const tab of allTabs) {
                if (!hasAttr(tab, 'aria-controls')) {
                    failing.push(tab.substring(0, 120));
                }
            }
            expect(failing).toEqual([]);
        });

        test('every role="dialog" has aria-modal="true" and aria-labelledby', () => {
            const dialogRe = /<[^>]+role=["']dialog["'][^>]*>/gi;
            const dialogs = html.match(dialogRe) || [];
            expect(dialogs.length).toBeGreaterThan(0);

            const failingModal = [];
            const failingLabel = [];
            for (const dlg of dialogs) {
                if (!hasAttr(dlg, 'aria-modal')) {
                    failingModal.push(dlg.substring(0, 120));
                }
                if (!hasAttr(dlg, 'aria-labelledby')) {
                    failingLabel.push(dlg.substring(0, 120));
                }
            }
            expect(failingModal).toEqual([]);
            expect(failingLabel).toEqual([]);
        });
    });

    // =======================================================================
    // Group 2: No hardcoded inline styles that should be CSS classes
    // =======================================================================
    describe('Group 2: No hardcoded inline styles for colors/fonts', () => {
        test('inline styles should not set color, background, font-size, or font-weight', () => {
            // Extract all style="..." attribute values
            const styleRe = /style="([^"]*)"/gi;
            let match;
            const badPatterns = [
                /\bcolor\s*:/i,
                /\bbackground\s*:/i,
                /\bfont-size\s*:/i,
                /\bfont-weight\s*:/i,
            ];
            const violations = [];

            while ((match = styleRe.exec(html)) !== null) {
                const styleValue = match[1];
                for (const pat of badPatterns) {
                    if (pat.test(styleValue)) {
                        violations.push({ style: styleValue.substring(0, 80), pattern: pat.source });
                        break; // One violation per style attribute is enough
                    }
                }
            }

            // TODO: Ideal threshold is 0. Adjust if the codebase currently has some
            // legitimate inline color/font styles that can't easily be moved to CSS.
            expect(violations.length).toBe(0);
        });
    });

    // =======================================================================
    // Group 3: Image and icon accessibility
    // =======================================================================
    describe('Group 3: Image and icon accessibility', () => {
        test('every <img> has an alt attribute', () => {
            const images = extractTags(html, 'img');
            const failing = [];
            for (const img of images) {
                if (!hasAttr(img, 'alt')) {
                    failing.push(img.substring(0, 120));
                }
            }
            // If there are no images, that's fine — test passes vacuously
            expect(failing).toEqual([]);
        });

        test('every <svg> has aria-hidden="true" (decorative icons)', () => {
            const svgs = extractTags(html, 'svg');
            expect(svgs.length).toBeGreaterThan(0);

            const failing = [];
            for (const svg of svgs) {
                if (!hasAttr(svg, 'aria-hidden')) {
                    failing.push(svg.substring(0, 120));
                }
            }
            expect(failing).toEqual([]);
        });

        test('icon-only buttons (containing only SVG) have aria-label or title', () => {
            // Find buttons that contain an SVG but no meaningful text content
            const buttonRe = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
            let match;
            const failing = [];

            while ((match = buttonRe.exec(html)) !== null) {
                const fullTag = match[0];
                const openTag = fullTag.match(/<button\b[^>]*>/i)[0];
                const content = match[1];
                // Check if content contains SVG
                if (/<svg\b/i.test(content)) {
                    // Strip all tags to get text
                    const textOnly = content.replace(/<[^>]*>/g, '').trim();
                    if (textOnly.length === 0) {
                        // Icon-only button — must have aria-label or title
                        if (!hasAttr(openTag, 'aria-label') && !hasAttr(openTag, 'title')) {
                            failing.push(openTag.substring(0, 120));
                        }
                    }
                }
            }
            expect(failing).toEqual([]);
        });
    });

    // =======================================================================
    // Group 4: Link and navigation
    // =======================================================================
    describe('Group 4: Link and navigation', () => {
        test('every <a> tag has an href attribute', () => {
            const links = extractTags(html, 'a');
            const failing = [];
            for (const link of links) {
                if (!hasAttr(link, 'href')) {
                    failing.push(link.substring(0, 120));
                }
            }
            // If there are no links, that's fine
            expect(failing).toEqual([]);
        });

        test('external links have rel="noopener noreferrer" and target="_blank"', () => {
            const links = extractTags(html, 'a');
            const externalLinks = links.filter(link => {
                const href = getAttr(link, 'href');
                return href && /^https?:\/\//i.test(href);
            });
            const failingRel = [];
            const failingTarget = [];

            for (const link of externalLinks) {
                const rel = getAttr(link, 'rel') || '';
                if (!rel.includes('noopener') || !rel.includes('noreferrer')) {
                    failingRel.push(link.substring(0, 120));
                }
                if (!hasAttr(link, 'target') || getAttr(link, 'target') !== '_blank') {
                    failingTarget.push(link.substring(0, 120));
                }
            }

            // Only assert if there are external links
            if (externalLinks.length > 0) {
                expect(failingRel).toEqual([]);
                expect(failingTarget).toEqual([]);
            }
        });
    });

    // =======================================================================
    // Group 5: Form quality
    // =======================================================================
    describe('Group 5: Form quality', () => {
        test('every <select> has an associated label or aria-label', () => {
            const selects = extractTags(html, 'select');
            expect(selects.length).toBeGreaterThan(0);

            const failing = [];
            for (const sel of selects) {
                const id = getAttr(sel, 'id');
                const hasLabel = hasAttr(sel, 'aria-label') || hasAttr(sel, 'title');
                const hasAssociatedLabel = id && html.includes(`for="${id}"`);
                if (!hasLabel && !hasAssociatedLabel) {
                    failing.push(sel.substring(0, 120));
                }
            }
            expect(failing).toEqual([]);
        });

        test('no text <input> uses placeholder as the only label', () => {
            const inputs = extractTags(html, 'input');
            const textInputs = inputs.filter(inp => {
                const type = getAttr(inp, 'type');
                return !type || type === 'text' || type === 'search' || type === 'number';
            });

            const failing = [];
            for (const inp of textInputs) {
                if (hasAttr(inp, 'placeholder')) {
                    const id = getAttr(inp, 'id');
                    const hasLabel = hasAttr(inp, 'aria-label') || hasAttr(inp, 'title');
                    const hasAssociatedLabel = id && html.includes(`for="${id}"`);
                    // Check if wrapped in a <label> element
                    let wrappedInLabel = false;
                    const idx = html.indexOf(inp);
                    if (idx > -1) {
                        const before = html.substring(Math.max(0, idx - 300), idx);
                        const after = html.substring(idx, Math.min(html.length, idx + inp.length + 300));
                        wrappedInLabel = before.includes('<label') && after.includes('</label>');
                    }
                    if (!hasLabel && !hasAssociatedLabel && !wrappedInLabel) {
                        failing.push(inp.substring(0, 120));
                    }
                }
            }
            expect(failing).toEqual([]);
        });
    });

    // =======================================================================
    // Group 6: Semantic structure
    // =======================================================================
    describe('Group 6: Semantic structure', () => {
        test('at most one <main> element', () => {
            const mains = extractTags(html, 'main');
            expect(mains.length).toBeLessThanOrEqual(1);
        });

        test('has <nav> elements for navigation', () => {
            const navs = extractTags(html, 'nav');
            expect(navs.length).toBeGreaterThan(0);
        });

        test('page sections use <section> elements', () => {
            const sections = extractTags(html, 'section');
            expect(sections.length).toBeGreaterThan(0);
        });

        test('HTML has a lang attribute', () => {
            expect(html).toMatch(/<html[^>]+lang="/);
        });

        test('HTML has a meta viewport tag', () => {
            expect(html).toContain('meta name="viewport"');
        });
    });

    // =======================================================================
    // Group 7: Collapsible sections and ARIA
    // =======================================================================
    describe('Group 7: Collapsible sections and ARIA', () => {
        test('all collapsible headers have aria-expanded', () => {
            // Find elements with class containing "collapsible-header" as a whole word
            // (not collapsible-header-title or other substrings)
            const collapsibleHeaderRe = /<[^>]+class="[^"]*\bcollapsible-header\b(?!-)[^"]*"[^>]*>/gi;
            const collapsibleHeaders = html.match(collapsibleHeaderRe) || [];
            expect(collapsibleHeaders.length).toBeGreaterThan(0);

            const failing = [];
            for (const hdr of collapsibleHeaders) {
                if (!hasAttr(hdr, 'aria-expanded')) {
                    failing.push(hdr.substring(0, 120));
                }
            }
            expect(failing).toEqual([]);
        });

        test('no empty href="#" links (should use buttons or proper links)', () => {
            const links = extractTags(html, 'a');
            const hashLinks = links.filter(link => {
                const href = getAttr(link, 'href');
                return href === '#';
            });

            if (hashLinks.length > 0) {
                console.log('  Links with href="#":');
                hashLinks.forEach(l => console.log(`    ${l.substring(0, 120)}`));
            }
            expect(hashLinks).toEqual([]);
        });

        test('all tab panels have role="tabpanel"', () => {
            // Find elements that are tab content panels:
            // - .tab-panel elements in the bottom drawer
            // - .routing-tab-panel elements in routing section
            const tabPanelRe = /<div\b[^>]*class="[^"]*\btab-panel\b[^"]*"[^>]*>/gi;
            const tabPanels = html.match(tabPanelRe) || [];
            expect(tabPanels.length).toBeGreaterThan(0);

            const failing = [];
            for (const panel of tabPanels) {
                if (!/role=["']tabpanel["']/i.test(panel)) {
                    failing.push(panel.substring(0, 120));
                }
            }
            expect(failing).toEqual([]);
        });
    });
});
