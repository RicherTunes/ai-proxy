'use strict';

/**
 * Dashboard Frontend Coverage Tests
 *
 * Comprehensive tests for previously uncovered frontend functionality:
 * - Page navigation (switchPage)
 * - Routing tab switching (switchRoutingTab)
 * - Dock tab/panel pairing
 * - data-action handler completeness
 * - Space-separated data-belongs-to matching
 * - CSS visibility contracts
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { generateDashboard } = require('../lib/dashboard');

let html;
let initSource;

beforeAll(() => {
    html = generateDashboard({ nonce: '', cspEnabled: false });
    initSource = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'js', 'init.js'),
        'utf8'
    );
});

// ── Page Navigation ──────────────────────────────────────────────────────

describe('Page navigation (switchPage)', () => {
    let doc;

    function switchPage(pageName) {
        doc.querySelectorAll('.page-nav-btn').forEach(function (btn) {
            var isActive = btn.dataset.page === pageName;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
            if (isActive) btn.setAttribute('aria-current', 'page');
            else btn.removeAttribute('aria-current');
        });
        doc.querySelectorAll('.page-section[data-belongs-to]').forEach(function (section) {
            var pages = section.dataset.belongsTo.split(' ');
            section.classList.toggle('page-hidden', !pages.includes(pageName));
        });
    }

    beforeEach(() => {
        doc = new JSDOM(html).window.document;
    });

    test('four page nav buttons exist: overview, routing, requests, system', () => {
        const btns = doc.querySelectorAll('.page-nav-btn');
        const pages = Array.from(btns).map(b => b.dataset.page);
        expect(pages).toEqual(['overview', 'routing', 'requests', 'system']);
    });

    test('overview is active by default', () => {
        const btn = doc.querySelector('.page-nav-btn[data-page="overview"]');
        expect(btn.classList.contains('active')).toBe(true);
        expect(btn.getAttribute('aria-selected')).toBe('true');
        expect(btn.getAttribute('aria-current')).toBe('page');
    });

    test('every page nav button has at least one matching section', () => {
        const btns = doc.querySelectorAll('.page-nav-btn');
        btns.forEach(btn => {
            const page = btn.dataset.page;
            // data-belongs-to can be space-separated, so we need to check if any section includes this page
            const sections = doc.querySelectorAll('.page-section[data-belongs-to]');
            const matchingSections = Array.from(sections).filter(s =>
                s.dataset.belongsTo.split(' ').includes(page)
            );
            expect(matchingSections.length).toBeGreaterThan(0);
        });
    });

    test('switching to routing shows routing sections, hides others', () => {
        switchPage('routing');

        const routingSections = doc.querySelectorAll('.page-section[data-belongs-to*="routing"]');
        routingSections.forEach(s => {
            if (s.dataset.belongsTo.split(' ').includes('routing')) {
                expect(s.classList.contains('page-hidden')).toBe(false);
            }
        });

        const overviewSections = doc.querySelectorAll('.page-section[data-belongs-to="overview"]');
        overviewSections.forEach(s => {
            expect(s.classList.contains('page-hidden')).toBe(true);
        });
    });

    test('switching to requests shows requests sections, hides others', () => {
        switchPage('requests');

        const requestsSections = doc.querySelectorAll('.page-section[data-belongs-to*="requests"]');
        requestsSections.forEach(s => {
            if (s.dataset.belongsTo.split(' ').includes('requests')) {
                expect(s.classList.contains('page-hidden')).toBe(false);
            }
        });

        const systemSections = doc.querySelectorAll('.page-section[data-belongs-to="system"]');
        systemSections.forEach(s => {
            expect(s.classList.contains('page-hidden')).toBe(true);
        });
    });

    test('switching to system shows system sections', () => {
        switchPage('system');

        const systemSections = doc.querySelectorAll('.page-section[data-belongs-to="system"]');
        expect(systemSections.length).toBeGreaterThan(0);
        systemSections.forEach(s => {
            expect(s.classList.contains('page-hidden')).toBe(false);
        });
    });

    test('round-trip: overview → routing → requests → system → overview', () => {
        ['overview', 'routing', 'requests', 'system', 'overview'].forEach(page => {
            switchPage(page);

            // Active button matches
            const activeBtn = doc.querySelector('.page-nav-btn.active');
            expect(activeBtn.dataset.page).toBe(page);

            // Only sections belonging to this page are visible
            doc.querySelectorAll('.page-section[data-belongs-to]').forEach(section => {
                const pages = section.dataset.belongsTo.split(' ');
                if (pages.includes(page)) {
                    expect(section.classList.contains('page-hidden')).toBe(false);
                } else {
                    expect(section.classList.contains('page-hidden')).toBe(true);
                }
            });
        });
    });

    test('only one nav button is active at a time', () => {
        ['overview', 'routing', 'requests', 'system'].forEach(page => {
            switchPage(page);
            const activeBtns = doc.querySelectorAll('.page-nav-btn.active');
            expect(activeBtns.length).toBe(1);
            expect(activeBtns[0].dataset.page).toBe(page);
        });
    });

    test('aria-current="page" is set only on active button', () => {
        switchPage('routing');
        const btns = doc.querySelectorAll('.page-nav-btn');
        btns.forEach(btn => {
            if (btn.dataset.page === 'routing') {
                expect(btn.getAttribute('aria-current')).toBe('page');
            } else {
                expect(btn.hasAttribute('aria-current')).toBe(false);
            }
        });
    });
});

// ── Routing Tab Switching ────────────────────────────────────────────────

describe('Routing tab switching (switchRoutingTab)', () => {
    let doc;

    function switchRoutingTab(tabName) {
        doc.querySelectorAll('.routing-tab-btn').forEach(function (btn) {
            var isActive = btn.dataset.routingTab === tabName;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
            btn.setAttribute('tabindex', isActive ? '0' : '-1');
        });
        doc.querySelectorAll('.routing-tab-panel').forEach(function (panel) {
            panel.classList.toggle('active', panel.dataset.routingPanel === tabName);
        });
    }

    beforeEach(() => {
        doc = new JSDOM(html).window.document;
    });

    test('four routing tab buttons exist', () => {
        const btns = doc.querySelectorAll('.routing-tab-btn');
        const tabNames = Array.from(btns).map(b => b.dataset.routingTab);
        expect(tabNames).toEqual(['observability', 'cooldowns', 'overrides', 'advanced']);
    });

    test('four routing tab panels exist', () => {
        const panels = doc.querySelectorAll('.routing-tab-panel');
        const panelNames = Array.from(panels).map(p => p.dataset.routingPanel);
        expect(panelNames).toEqual(['observability', 'cooldowns', 'overrides', 'advanced']);
    });

    test('observability tab is active by default', () => {
        const btn = doc.querySelector('.routing-tab-btn[data-routing-tab="observability"]');
        expect(btn.classList.contains('active')).toBe(true);

        const panel = doc.querySelector('.routing-tab-panel[data-routing-panel="observability"]');
        expect(panel.classList.contains('active')).toBe(true);
    });

    test('every routing tab button has a matching panel', () => {
        const btns = doc.querySelectorAll('.routing-tab-btn');
        btns.forEach(btn => {
            const tabName = btn.dataset.routingTab;
            const panel = doc.querySelector(`.routing-tab-panel[data-routing-panel="${tabName}"]`);
            expect(panel).not.toBeNull();
        });
    });

    test('switching to cooldowns activates cooldowns panel, deactivates others', () => {
        switchRoutingTab('cooldowns');

        const cooldownsPanel = doc.querySelector('[data-routing-panel="cooldowns"]');
        expect(cooldownsPanel.classList.contains('active')).toBe(true);

        const obsPanel = doc.querySelector('[data-routing-panel="observability"]');
        expect(obsPanel.classList.contains('active')).toBe(false);
    });

    test('switching to advanced activates advanced panel only', () => {
        switchRoutingTab('advanced');

        const panels = doc.querySelectorAll('.routing-tab-panel');
        panels.forEach(panel => {
            if (panel.dataset.routingPanel === 'advanced') {
                expect(panel.classList.contains('active')).toBe(true);
            } else {
                expect(panel.classList.contains('active')).toBe(false);
            }
        });
    });

    test('only one routing tab is active at a time', () => {
        ['observability', 'cooldowns', 'overrides', 'advanced'].forEach(tab => {
            switchRoutingTab(tab);

            const activeBtns = doc.querySelectorAll('.routing-tab-btn.active');
            expect(activeBtns.length).toBe(1);
            expect(activeBtns[0].dataset.routingTab).toBe(tab);

            const activePanels = doc.querySelectorAll('.routing-tab-panel.active');
            expect(activePanels.length).toBe(1);
            expect(activePanels[0].dataset.routingPanel).toBe(tab);
        });
    });

    test('round-trip preserves correct state', () => {
        switchRoutingTab('advanced');
        switchRoutingTab('cooldowns');
        switchRoutingTab('observability');

        const activeBtn = doc.querySelector('.routing-tab-btn.active');
        expect(activeBtn.dataset.routingTab).toBe('observability');

        const activePanel = doc.querySelector('.routing-tab-panel.active');
        expect(activePanel.dataset.routingPanel).toBe('observability');
    });

    test('aria-selected is correctly toggled', () => {
        switchRoutingTab('overrides');

        doc.querySelectorAll('.routing-tab-btn').forEach(btn => {
            const expected = btn.dataset.routingTab === 'overrides' ? 'true' : 'false';
            expect(btn.getAttribute('aria-selected')).toBe(expected);
        });
    });
});

// ── Dock Tab / Panel Pairing ─────────────────────────────────────────────

describe('Dock tab and panel completeness', () => {
    let doc;

    beforeAll(() => {
        doc = new JSDOM(html).window.document;
    });

    const DOCK_TABS = ['live', 'traces', 'logs', 'queue', 'circuit'];

    test('all five dock tab buttons exist in drawer', () => {
        const drawer = doc.getElementById('bottomDrawer');
        DOCK_TABS.forEach(tabName => {
            const btn = drawer.querySelector(`.dock-tab[data-dock-tab="${tabName}"]`);
            expect(btn).not.toBeNull();
        });
    });

    test('all five dock tab panels exist in HTML', () => {
        DOCK_TABS.forEach(tabName => {
            const panel = doc.getElementById('tab-' + tabName);
            expect(panel).not.toBeNull();
        });
    });

    test('dock tab buttons have correct data-testid', () => {
        DOCK_TABS.forEach(tabName => {
            const btn = doc.querySelector(`[data-testid="tab-${tabName}"]`);
            expect(btn).not.toBeNull();
        });
    });

    test('dock tab buttons have switch-dock-tab action', () => {
        const drawer = doc.getElementById('bottomDrawer');
        const btns = drawer.querySelectorAll('.dock-tab');
        btns.forEach(btn => {
            expect(btn.dataset.action).toBe('switch-dock-tab');
        });
    });

    test('Live dock tab is active by default', () => {
        const liveBtn = doc.querySelector('.dock-tab[data-dock-tab="live"]');
        expect(liveBtn.classList.contains('active')).toBe(true);
        expect(liveBtn.getAttribute('aria-selected')).toBe('true');
    });
});

// ── data-action Handler Completeness ─────────────────────────────────────

describe('data-action handler completeness', () => {
    let doc;

    // All actions handled in init.js switch statement
    const HANDLED_ACTIONS = new Set([
        'switch-page', 'switch-dock-tab', 'switch-routing-tab',
        'switch-request-tab', 'switch-tab',
        'set-time-range', 'toggle-theme', 'set-density',
        'export-data', 'share-url',
        'show-shortcuts-modal', 'show-login', 'logout',
        'control-pause', 'control-resume',
        'reload-keys', 'select-key', 'close-key-details',
        'force-circuit', 'force-circuit-state',
        'open-key-override-modal', 'close-key-override-modal',
        'add-override', 'save-key-overrides', 'remove-override',
        'reset-stats', 'clear-logs', 'reset-all-circuits',
        'clear-queue', 'export-diagnostics',
        'toggle-fullscreen', 'toggle-search', 'toggle-time-dropdown',
        'toggle-account-details', 'chart-nav',
        'toggle-live-compact-more', 'toggle-live-panel-compact', 'toggle-live-panel-scope',
        'dismiss-issues', 'handle-issue-action', 'reopen-issues',
        'close-modal', 'close-toast',
        'filter-change', 'clear-filters',
        'toggle-autoscroll', 'jump-to-latest', 'toggle-ordering',
        'copy-value',
        'load-traces', 'trace-filter-change', 'show-trace',
        'close-trace-detail', 'trace-search', 'export-traces',
        'clear-trace-filters', 'copy-trace-id', 'copy-trace-json',
        'set-routing-time', 'copy-routing-snapshot',
        'run-routing-test', 'run-explain',
        'add-routing-override', 'remove-routing-override',
        'add-routing-rule', 'remove-routing-rule',
        'save-tier', 'reset-model-routing',
        'copy-routing-json', 'export-routing-json',
        'toggle-drawer', 'toggle-overflow-menu', 'toggle-routing-tabs',
        'close-panel', 'view-request',
        'toggle-upgrade-info', 'reload-page', 'dismiss-banner',
        'noop', 'kpi-navigate', 'enable-routing', 'toggle-routing', 'scroll-to-account-usage',
        'toggle-global-mapping',
        // Nested sub-cases
        'sort-models', 'select-tenant',
        // Handled in context-menu.js (separate event listener)
        'context-copy-id', 'context-filter-by-key',
        'context-view-similar', 'context-investigate'
    ]);

    beforeAll(() => {
        doc = new JSDOM(html).window.document;
    });

    test('every data-action in HTML has a handler in init.js', () => {
        const elements = doc.querySelectorAll('[data-action]');
        const usedActions = new Set();
        elements.forEach(el => usedActions.add(el.dataset.action));

        const unhandled = [];
        usedActions.forEach(action => {
            if (!HANDLED_ACTIONS.has(action)) {
                unhandled.push(action);
            }
        });

        expect(unhandled).toEqual([]);
    });

    test('at least 20 unique data-action values are used in HTML', () => {
        const elements = doc.querySelectorAll('[data-action]');
        const usedActions = new Set();
        elements.forEach(el => usedActions.add(el.dataset.action));
        expect(usedActions.size).toBeGreaterThanOrEqual(20);
    });

    test('init.js or context-menu.js contains a case for each handled action', () => {
        const contextMenuSource = fs.readFileSync(
            path.join(__dirname, '..', 'public', 'js', 'context-menu.js'),
            'utf8'
        );
        const allSource = initSource + contextMenuSource;
        HANDLED_ACTIONS.forEach(action => {
            const pattern = new RegExp(`case\\s*'${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
            expect(allSource).toMatch(pattern);
        });
    });
});

// ── Space-Separated data-belongs-to Matching ─────────────────────────────

describe('Space-separated data-belongs-to integrity', () => {
    let doc;

    beforeAll(() => {
        doc = new JSDOM(html).window.document;
    });

    test('all data-belongs-to values reference valid page names', () => {
        const validPages = new Set(['overview', 'routing', 'requests', 'system']);
        const sections = doc.querySelectorAll('[data-belongs-to]');

        sections.forEach(section => {
            const pages = section.dataset.belongsTo.split(' ');
            pages.forEach(page => {
                expect(validPages.has(page)).toBe(true);
            });
        });
    });

    test('switchPage in init.js uses space-separated split for data-belongs-to', () => {
        expect(initSource).toMatch(/belongsTo\.split\(['"]\s*['"]\)/);
    });

    test('no data-belongs-to values are empty strings', () => {
        const sections = doc.querySelectorAll('[data-belongs-to]');
        sections.forEach(section => {
            expect(section.dataset.belongsTo.trim().length).toBeGreaterThan(0);
        });
    });
});

// ── Hash Routing Contracts ───────────────────────────────────────────────

describe('Hash routing contracts', () => {
    test('HASH_ROUTES includes requests/table explicit route', () => {
        expect(initSource).toMatch(/'requests\/table':\s*\{\s*page:\s*'requests',\s*subPage:\s*'table'\s*\}/);
    });

    test('HASH_ROUTES maps bare requests hash to table sub-tab', () => {
        expect(initSource).toMatch(/'requests':\s*\{\s*page:\s*'requests',\s*subPage:\s*'table'\s*\}/);
    });

    test('screenshot mode reads query param and toggles body class', () => {
        expect(initSource).toMatch(/SCREENSHOT_QUERY_PARAM\s*=\s*'screenshot'/);
        expect(initSource).toMatch(/\.get\(SCREENSHOT_QUERY_PARAM\)/);
        expect(initSource).toMatch(/document\.body\.classList\.toggle\('screenshot-mode', enabled\)/);
    });
});

// ── CSS Visibility Contracts ─────────────────────────────────────────────

describe('CSS visibility contracts', () => {
    let layoutCSS, requestsCSS, routingCSS;

    beforeAll(() => {
        const cssDir = path.join(__dirname, '..', 'public', 'css');
        layoutCSS = fs.readFileSync(path.join(cssDir, 'layout.css'), 'utf8');
        requestsCSS = fs.readFileSync(path.join(cssDir, 'requests.css'), 'utf8');
        routingCSS = fs.readFileSync(path.join(cssDir, 'routing.css'), 'utf8');
    });

    test('routing-tab-panel default is display: none', () => {
        expect(routingCSS).toMatch(/\.routing-tab-panel\s*\{[^}]*display:\s*none/);
    });

    test('routing-tab-panel.active is display: block', () => {
        expect(routingCSS).toMatch(/\.routing-tab-panel\.active\s*\{[^}]*display:\s*block/);
    });

    test('tab-panel default is display: none', () => {
        expect(requestsCSS).toMatch(/\.tab-panel\s*\{[^}]*display:\s*none/);
    });

    test('tab-panel.active is display: block', () => {
        expect(requestsCSS).toMatch(/\.tab-panel\.active\s*\{[^}]*display:\s*block/);
    });

    test('drawer-content default is display: none (collapsed)', () => {
        expect(layoutCSS).toMatch(/\.bottom-drawer\s+\.drawer-content\s*\{[^}]*display:\s*none/);
    });

    test('drawer-content is display: block when expanded', () => {
        expect(layoutCSS).toMatch(/\.bottom-drawer\.expanded\s+\.drawer-content\s*\{[^}]*display:\s*block/);
    });

    test('bottom drawer is NOT force-hidden', () => {
        const match = layoutCSS.match(/\.bottom-drawer\s*\{[^}]*display:\s*none\s*!important/);
        expect(match).toBeNull();
    });

    test('screenshot mode renders drawer in document flow for full-page capture', () => {
        expect(layoutCSS).toMatch(/body\.screenshot-mode\s+\.bottom-drawer\s*\{[^}]*position:\s*static/);
    });
});

// ── CSS Component Contracts ──────────────────────────────────────────────

describe('CSS component contracts', () => {
    let componentsCSS;
    let layoutCSS;

    beforeAll(() => {
        const cssDir = path.join(__dirname, '..', 'public', 'css');
        componentsCSS = fs.readFileSync(path.join(cssDir, 'components.css'), 'utf8');
        layoutCSS = fs.readFileSync(path.join(cssDir, 'layout.css'), 'utf8');
    });

    const TIER_BADGE_VARIANTS = ['heavy', 'medium', 'light', 'free', 'unknown'];

    TIER_BADGE_VARIANTS.forEach(variant => {
        test(`tier-badge-${variant} class is defined`, () => {
            expect(componentsCSS).toMatch(new RegExp('\\.tier-badge-' + variant + '\\s*\\{'));
        });
    });

    test('tier-badge base class is defined', () => {
        expect(componentsCSS).toMatch(/\.tier-badge\s*\{/);
    });

    test('no dangerous .visible global override in utilities', () => {
        const cssDir = path.join(__dirname, '..', 'public', 'css');
        const utilitiesCSS = fs.readFileSync(path.join(cssDir, 'utilities.css'), 'utf8');
        // .visible { display: block !important } would break flex modals
        expect(utilitiesCSS).not.toMatch(/\.visible\s*\{\s*display:\s*block\s*!important/);
    });

    test('screenshot mode hides floating overlays', () => {
        expect(layoutCSS).toMatch(/body\.screenshot-mode\s+\.shortcuts-help-btn[^}]*display:\s*none/);
        expect(layoutCSS).toMatch(/body\.screenshot-mode\s+\.toast-container[^}]*display:\s*none/);
        expect(layoutCSS).toMatch(/body\.screenshot-mode\s+\.context-menu[^}]*display:\s*none/);
    });
});

// ── Critical Element IDs ─────────────────────────────────────────────────

describe('Critical element IDs referenced by JS exist in HTML', () => {
    let doc;

    beforeAll(() => {
        doc = new JSDOM(html).window.document;
    });

    // IDs referenced by init.js
    const INIT_JS_IDS = [
        'bottomDrawer', 'drawerContent', 'dockPanelsContainer',
        'requestsSubTabs', 'shortcutsModal', 'requestCountBadge',
        'sidePanelBackdrop', 'sidePanel', 'sidePanelBody',
    ];

    test.each(INIT_JS_IDS)('element with id="%s" exists', (id) => {
        expect(doc.getElementById(id)).not.toBeNull();
    });

    // IDs referenced by data.js for chart initialization
    const CHART_IDS = [
        'requestChart', 'latencyChart', 'errorChart', 'distChart',
    ];

    test.each(CHART_IDS)('chart canvas id="%s" exists', (id) => {
        expect(doc.getElementById(id)).not.toBeNull();
    });

    // IDs referenced by SSE/data updates
    const STAT_IDS = [
        'reqPageTotal', 'reqPageSuccessRate', 'reqPageAvgLatency',
        'reqPageErrors', 'reqPageInFlight',
        'statusDot',
    ];

    test.each(STAT_IDS)('stat element id="%s" exists', (id) => {
        expect(doc.getElementById(id)).not.toBeNull();
    });
});

// ── Keyboard Shortcut Targets ────────────────────────────────────────────

describe('Keyboard shortcut targets', () => {
    let doc;

    beforeAll(() => {
        doc = new JSDOM(html).window.document;
    });

    test('shortcuts modal exists', () => {
        expect(doc.getElementById('shortcutsModal')).not.toBeNull();
    });

    test('shortcuts modal has shortcut items', () => {
        const items = doc.querySelectorAll('#shortcutsModal .shortcut-item');
        expect(items.length).toBeGreaterThan(5);
    });

    test('"l" shortcut target: requests page and live tab exist', () => {
        // l → switchPage('requests'); switchRequestTab('live')
        const requestsBtn = doc.querySelector('.page-nav-btn[data-page="requests"]');
        expect(requestsBtn).not.toBeNull();

        const liveTab = doc.querySelector('#requestsSubTabs .sub-tab[data-tab="live"]');
        expect(liveTab).not.toBeNull();
    });

    test('"?" shortcut target: shortcuts modal exists', () => {
        expect(doc.getElementById('shortcutsModal')).not.toBeNull();
    });

    test('number key shortcut targets: request sub-tabs exist', () => {
        // 1 → switchRequestTab('live'), 2 → switchRequestTab('traces')
        expect(doc.querySelector('.sub-tab[data-tab="live"]')).not.toBeNull();
        expect(doc.querySelector('.sub-tab[data-tab="traces"]')).not.toBeNull();
    });
});
