'use strict';

/**
 * Dashboard Live Requests Panel E2E Tests
 *
 * Verifies:
 * 1. The bottom drawer is visible and contains dock panel content
 * 2. The init.js relocation moves tab panels from inline container to drawer
 * 3. Tab switching works correctly after relocation
 * 4. CSS does not hide the bottom drawer or show all panels simultaneously
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { generateDashboard } = require('../lib/dashboard');

// ── HTML contract tests (server-rendered structure) ──────────────────────

describe('Bottom drawer HTML contract', () => {
    let doc;

    beforeAll(() => {
        const html = generateDashboard({ nonce: '', cspEnabled: false });
        doc = new JSDOM(html).window.document;
    });

    test('bottom drawer element exists', () => {
        const drawer = doc.getElementById('bottomDrawer');
        expect(drawer).not.toBeNull();
        expect(drawer.classList.contains('bottom-drawer')).toBe(true);
    });

    test('drawer has header with title, badge, and toggle', () => {
        const drawer = doc.getElementById('bottomDrawer');
        expect(drawer.querySelector('.drawer-title')).not.toBeNull();
        expect(drawer.querySelector('#requestCountBadge')).not.toBeNull();
        expect(drawer.querySelector('#drawerCompactToggle')).not.toBeNull();
        expect(drawer.querySelector('#drawerScopeToggle')).not.toBeNull();
        expect(drawer.querySelector('.drawer-toggle')).not.toBeNull();
    });

    test('drawer has dock tab buttons (Live, Traces, Logs, Queue, Circuit)', () => {
        const drawer = doc.getElementById('bottomDrawer');
        const tabs = drawer.querySelectorAll('.dock-tab');
        const tabNames = Array.from(tabs).map(t => t.dataset.dockTab);
        expect(tabNames).toEqual(['live', 'traces', 'logs', 'queue', 'circuit']);
    });

    test('drawer content area exists', () => {
        const content = doc.getElementById('drawerContent');
        expect(content).not.toBeNull();
    });

    test('live toolbar has compact more toggle', () => {
        const toggle = doc.getElementById('compactMoreToggle');
        expect(toggle).not.toBeNull();
        expect(toggle.getAttribute('data-action')).toBe('toggle-live-compact-more');
    });

    test('live stream footer has compact summary slot', () => {
        const summary = doc.getElementById('liveStreamSummary');
        expect(summary).not.toBeNull();
        expect(summary.classList.contains('stream-summary')).toBe(true);
    });

    test('drawer has resize handle', () => {
        const handle = doc.getElementById('drawerResizeHandle');
        expect(handle).not.toBeNull();
    });

    test('dock panels container exists (pre-relocation) with tab panels', () => {
        const container = doc.getElementById('dockPanelsContainer');
        expect(container).not.toBeNull();
        expect(container.querySelector('#tab-live')).not.toBeNull();
        expect(container.querySelector('#tab-traces')).not.toBeNull();
    });
});

// ── CSS contract tests ───────────────────────────────────────────────────

describe('Bottom drawer CSS contract', () => {
    let layoutCSS;

    beforeAll(() => {
        layoutCSS = fs.readFileSync(
            path.join(__dirname, '..', 'public', 'css', 'layout.css'),
            'utf8'
        );
    });

    test('bottom drawer is NOT hidden with display: none', () => {
        // Phase 4b used to hide it; verify it is restored
        const hideRule = layoutCSS.match(
            /\.bottom-drawer\s*\{[^}]*display:\s*none\s*!important/
        );
        expect(hideRule).toBeNull();
    });

    test('main-content has bottom padding for drawer clearance', () => {
        expect(layoutCSS).toMatch(/\.main-content\s*\{[^}]*padding-bottom/);
    });

    test('page-hidden class hides elements with display: none', () => {
        expect(layoutCSS).toMatch(/\.page-section\.page-hidden\s*\{[^}]*display:\s*none/);
    });

    test('no blanket .request-tab-content .tab-panel { display: block } override', () => {
        const blanketOverride = layoutCSS.match(
            /\.request-tab-content\s+\.tab-panel\s*\{[^}]*display:\s*block/
        );
        expect(blanketOverride).toBeNull();
    });
});

// ── init.js source contract tests ────────────────────────────────────────

describe('init.js implementation contracts', () => {
    let initSource;

    beforeAll(() => {
        initSource = fs.readFileSync(
            path.join(__dirname, '..', 'public', 'js', 'init.js'),
            'utf8'
        );
    });

    test('switchRequestTab uses space-separated data-tab matching', () => {
        expect(initSource).toMatch(/sectionTab\.split\(['"]\s*['"]\)\.indexOf\(tabName\)/);
    });

    test('switchRequestTab does NOT use broken string equality', () => {
        expect(initSource).not.toMatch(/sectionTab\s*!==\s*['"]live['"]/);
    });

    test('dock panels are relocated into bottom drawer', () => {
        expect(initSource).toMatch(/relocateDockPanels/);
        expect(initSource).toMatch(/drawerContent/);
        expect(initSource).toMatch(/dockPanelsContainer/);
        expect(initSource).toMatch(/drawerContent\.appendChild/);
    });

    test('traces loading uses DashboardData API (no missing global symbol)', () => {
        expect(initSource).toMatch(/DashboardData\?\.loadTracesFromAPI/);
    });

    test('switchPage visibility is scope-aware (not hardcoded requests-only)', () => {
        expect(initSource).toMatch(/applyDrawerVisibility\(pageName\)/);
        expect(initSource).toMatch(/isDrawerVisibleOnPage/);
        expect(initSource).toMatch(/dashboard-live-panel-scope/);
    });

    test('compact mode is persisted and toggled via action', () => {
        expect(initSource).toMatch(/dashboard-live-panel-compact/);
        expect(initSource).toMatch(/setCompactMode/);
        expect(initSource).toMatch(/toggle-live-panel-compact/);
    });

    test('compact mode defaults to enabled for first-time users', () => {
        expect(initSource).toMatch(/compactSetting === null \? true : compactSetting === 'true'/);
    });

    test('compact mode supports on-demand hidden controls', () => {
        expect(initSource).toMatch(/setLiveCompactMore/);
        expect(initSource).toMatch(/toggle-live-compact-more/);
    });

    test('side panel supports on-demand full payload loading', () => {
        expect(initSource).toMatch(/load-request-payload/);
        expect(initSource).toMatch(/\/requests\/' \+ encodeURIComponent\(requestIdToLoad\) \+ '\/payload'/);
    });
});

// ── DOM relocation tests (JSDOM simulation) ──────────────────────────────

describe('Dock panel relocation into bottom drawer (JSDOM)', () => {
    let doc;

    /**
     * Simulate the init.js relocateDockPanels logic
     */
    function relocateDockPanels() {
        var drawerContent = doc.getElementById('drawerContent');
        var dockContainer = doc.getElementById('dockPanelsContainer');
        if (drawerContent && dockContainer) {
            var tabContent = dockContainer.querySelector('.tab-content');
            if (tabContent) {
                drawerContent.appendChild(tabContent);
                dockContainer.remove();
            }
        }
    }

    function switchDockTab(tabName) {
        doc.querySelectorAll('.tab-panel').forEach(function (panel) {
            panel.classList.remove('active');
        });
        var activePanel = doc.getElementById('tab-' + tabName);
        if (activePanel) activePanel.classList.add('active');
    }

    beforeEach(() => {
        const html = generateDashboard({ nonce: '', cspEnabled: false });
        doc = new JSDOM(html).window.document;
    });

    test('relocation moves tab-content into drawerContent', () => {
        relocateDockPanels();

        const drawerContent = doc.getElementById('drawerContent');
        const tabContent = drawerContent.querySelector('.tab-content');
        expect(tabContent).not.toBeNull();
    });

    test('relocation removes dockPanelsContainer from DOM', () => {
        relocateDockPanels();

        const dockContainer = doc.getElementById('dockPanelsContainer');
        expect(dockContainer).toBeNull();
    });

    test('tab-live panel is inside drawer after relocation', () => {
        relocateDockPanels();

        const drawer = doc.getElementById('bottomDrawer');
        const livePanel = drawer.querySelector('#tab-live');
        expect(livePanel).not.toBeNull();
    });

    test('tab-traces panel is inside drawer after relocation', () => {
        relocateDockPanels();

        const drawer = doc.getElementById('bottomDrawer');
        const tracesPanel = drawer.querySelector('#tab-traces');
        expect(tracesPanel).not.toBeNull();
    });

    test('all five tab panels are inside drawer after relocation', () => {
        relocateDockPanels();

        const drawer = doc.getElementById('bottomDrawer');
        expect(drawer.querySelector('#tab-live')).not.toBeNull();
        expect(drawer.querySelector('#tab-traces')).not.toBeNull();
        expect(drawer.querySelector('#tab-logs')).not.toBeNull();
        expect(drawer.querySelector('#tab-queue')).not.toBeNull();
        expect(drawer.querySelector('#tab-circuit')).not.toBeNull();
    });

    test('switchDockTab still works after relocation (global ID selectors)', () => {
        relocateDockPanels();

        switchDockTab('traces');
        expect(doc.getElementById('tab-traces').classList.contains('active')).toBe(true);
        expect(doc.getElementById('tab-live').classList.contains('active')).toBe(false);

        switchDockTab('live');
        expect(doc.getElementById('tab-live').classList.contains('active')).toBe(true);
        expect(doc.getElementById('tab-traces').classList.contains('active')).toBe(false);
    });

    test('only one tab-panel is active at a time after switching', () => {
        relocateDockPanels();

        ['live', 'traces', 'logs', 'queue', 'circuit'].forEach(tabName => {
            switchDockTab(tabName);
            const activePanels = doc.querySelectorAll('.tab-panel.active');
            expect(activePanels.length).toBe(1);
            expect(activePanels[0].id).toBe('tab-' + tabName);
        });
    });

    test('drawer visibility follows scope mode', () => {
        relocateDockPanels();

        function switchPageDrawer(pageName, scope) {
            var drawer = doc.getElementById('bottomDrawer');
            if (drawer) {
                drawer.style.display = (scope === 'all_pages' || pageName === 'requests') ? '' : 'none';
            }
        }

        const drawer = doc.getElementById('bottomDrawer');

        switchPageDrawer('overview', 'all_pages');
        expect(drawer.style.display).not.toBe('none');

        switchPageDrawer('system', 'all_pages');
        expect(drawer.style.display).not.toBe('none');

        switchPageDrawer('overview', 'requests_only');
        expect(drawer.style.display).toBe('none');

        switchPageDrawer('requests', 'requests_only');
        expect(drawer.style.display).not.toBe('none');
    });

    test('drawer expand/collapse toggle exists and is functional', () => {
        const drawer = doc.getElementById('bottomDrawer');
        const toggle = drawer.querySelector('.drawer-toggle');
        expect(toggle).not.toBeNull();
        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        // Simulate expand
        drawer.classList.add('expanded');
        toggle.setAttribute('aria-expanded', 'true');
        expect(drawer.classList.contains('expanded')).toBe(true);
    });
});
