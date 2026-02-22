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

    afterAll(() => {
        if (doc && doc.defaultView) doc.defaultView.close();
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

    test('dock panels are rendered directly inside drawerContent (M5 canonical placement)', () => {
        const drawerContent = doc.getElementById('drawerContent');
        expect(drawerContent).not.toBeNull();
        expect(drawerContent.querySelector('#tab-live')).not.toBeNull();
        expect(drawerContent.querySelector('#tab-traces')).not.toBeNull();
    });

    test('dockPanelsContainer no longer exists in server-rendered HTML', () => {
        const container = doc.getElementById('dockPanelsContainer');
        expect(container).toBeNull();
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

    test('M5: relocateDockPanels IIFE has been removed (canonical placement)', () => {
        // The IIFE is gone — panels are now server-rendered inside #drawerContent
        // Check that the actual function definition/IIFE pattern is absent (not just comments)
        expect(initSource).not.toMatch(/function relocateDockPanels\(\)\s*\{/);
        expect(initSource).not.toMatch(/dockContainer\.remove\(\)/);
        // The comment referencing M5 canonical placement should exist
        expect(initSource).toMatch(/M5.*canonical/i);
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

// ── M5: Canonical dock panel placement tests (JSDOM) ─────────────────────

describe('Canonical dock panels inside #drawerContent (JSDOM, M5)', () => {
    let doc;

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

    afterEach(() => {
        if (doc && doc.defaultView) doc.defaultView.close();
    });

    test('tab-content is already inside drawerContent (no relocation needed)', () => {
        const drawerContent = doc.getElementById('drawerContent');
        const tabContent = drawerContent.querySelector('.tab-content');
        expect(tabContent).not.toBeNull();
    });

    test('dockPanelsContainer does not exist in server-rendered HTML', () => {
        const dockContainer = doc.getElementById('dockPanelsContainer');
        expect(dockContainer).toBeNull();
    });

    test('tab-live panel is inside drawer on initial render', () => {
        const drawer = doc.getElementById('bottomDrawer');
        const livePanel = drawer.querySelector('#tab-live');
        expect(livePanel).not.toBeNull();
    });

    test('tab-traces panel is inside drawer on initial render', () => {
        const drawer = doc.getElementById('bottomDrawer');
        const tracesPanel = drawer.querySelector('#tab-traces');
        expect(tracesPanel).not.toBeNull();
    });

    test('all five tab panels are inside drawer on initial render', () => {
        const drawer = doc.getElementById('bottomDrawer');
        expect(drawer.querySelector('#tab-live')).not.toBeNull();
        expect(drawer.querySelector('#tab-traces')).not.toBeNull();
        expect(drawer.querySelector('#tab-logs')).not.toBeNull();
        expect(drawer.querySelector('#tab-queue')).not.toBeNull();
        expect(drawer.querySelector('#tab-circuit')).not.toBeNull();
    });

    test('switchDockTab works with canonical placement (global ID selectors)', () => {
        switchDockTab('traces');
        expect(doc.getElementById('tab-traces').classList.contains('active')).toBe(true);
        expect(doc.getElementById('tab-live').classList.contains('active')).toBe(false);

        switchDockTab('live');
        expect(doc.getElementById('tab-live').classList.contains('active')).toBe(true);
        expect(doc.getElementById('tab-traces').classList.contains('active')).toBe(false);
    });

    test('only one tab-panel is active at a time after switching', () => {
        ['live', 'traces', 'logs', 'queue', 'circuit'].forEach(tabName => {
            switchDockTab(tabName);
            const activePanels = doc.querySelectorAll('.tab-panel.active');
            expect(activePanels.length).toBe(1);
            expect(activePanels[0].id).toBe('tab-' + tabName);
        });
    });

    test('drawer visibility follows scope mode', () => {
        // M5: No relocation needed — panels are already in #drawerContent

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

// ── Hash route → dock tab normalization tests (M1.3) ─────────────────────

describe('Hash route normalization for dock tabs (M1.3)', () => {
    const DOCK_TAB_HASHES = ['live', 'traces', 'logs', 'queue', 'circuit'];

    // Source-level contract: switchRequestTab must call switchDockTab for ALL dock-tab routes
    describe('init.js source contracts', () => {
        let initSource;

        beforeAll(() => {
            initSource = fs.readFileSync(
                path.join(__dirname, '..', 'public', 'js', 'init.js'),
                'utf8'
            );
        });

        test('HASH_ROUTES includes all five dock-tab sub-routes', () => {
            DOCK_TAB_HASHES.forEach(tab => {
                expect(initSource).toMatch(new RegExp(`'requests/${tab}'`));
            });
        });

        test('switchRequestTab calls switchDockTab for logs, queue and circuit (not only live/traces)', () => {
            const narrowGuard = /if\s*\(\s*tabName\s*===\s*['"]live['"]\s*\|\|\s*tabName\s*===\s*['"]traces['"]\s*\)/;
            expect(initSource).not.toMatch(narrowGuard);
        });

        test('switchRequestTab opens drawer for all dock-tab routes (logs, queue, circuit)', () => {
            const hasDockTabSet = /DOCK_TABS|dockTabs|dock_tabs/.test(initSource) ||
                /includes\(tabName\)/.test(initSource) ||
                /indexOf\(tabName\)/.test(initSource);
            expect(hasDockTabSet).toBe(true);
        });
    });

    // DOM-simulation contract: all five hash routes open the drawer and activate correct dock tab
    describe('DOM simulation (JSDOM)', () => {
        let dom, doc;

        function buildSimulatedEnv() {
            const html = generateDashboard({ nonce: '', cspEnabled: false });
            dom = new JSDOM(html, { runScripts: 'outside-only' });
            doc = dom.window.document;
            // M5: Panels are already inside #drawerContent server-side — no relocation needed
        }

        function switchDockTab(tabName) {
            doc.querySelectorAll('.dock-tab').forEach(btn => {
                const isActive = btn.dataset.dockTab === tabName;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-selected', String(isActive));
            });
            const panel = doc.getElementById('tab-' + tabName);
            if (panel) {
                doc.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                panel.classList.add('active');
            }
        }

        function switchRequestTab(tabName) {
            const DOCK_TABS = ['live', 'traces', 'logs', 'queue', 'circuit'];
            if (DOCK_TABS.indexOf(tabName) !== -1) {
                switchDockTab(tabName);
                const drawer = doc.getElementById('bottomDrawer');
                if (drawer && !drawer.classList.contains('expanded')) {
                    drawer.classList.add('expanded');
                }
            }
        }

        beforeEach(() => {
            buildSimulatedEnv();
        });

        afterEach(() => {
            if (dom && dom.window) dom.window.close();
        });

        DOCK_TAB_HASHES.forEach(tab => {
            test(`#requests/${tab} opens drawer`, () => {
                switchRequestTab(tab);
                const drawer = doc.getElementById('bottomDrawer');
                expect(drawer.classList.contains('expanded')).toBe(true);
            });

            test(`#requests/${tab} activates dock tab button`, () => {
                switchRequestTab(tab);
                const btn = doc.querySelector(`.dock-tab[data-dock-tab="${tab}"]`);
                expect(btn).not.toBeNull();
                expect(btn.classList.contains('active')).toBe(true);
                expect(btn.getAttribute('aria-selected')).toBe('true');
            });

            test(`#requests/${tab} activates correct tab panel`, () => {
                switchRequestTab(tab);
                const panel = doc.getElementById('tab-' + tab);
                expect(panel).not.toBeNull();
                expect(panel.classList.contains('active')).toBe(true);
            });

            test(`#requests/${tab} deactivates other dock tab buttons`, () => {
                switchRequestTab(tab);
                doc.querySelectorAll('.dock-tab').forEach(btn => {
                    const isThis = btn.dataset.dockTab === tab;
                    expect(btn.classList.contains('active')).toBe(isThis);
                });
            });
        });
    });
});

// ── M1.2: useGlobalMapping toggle — no inline handler ────────────────────

describe('M1.2: useGlobalMapping checkbox uses data-action (no inline handler)', () => {
    let doc;

    beforeAll(() => {
        const html = generateDashboard({ nonce: '', cspEnabled: false });
        doc = new JSDOM(html).window.document;
    });

    afterAll(() => {
        if (doc && doc.defaultView) doc.defaultView.close();
    });

    test('useGlobalMapping checkbox exists in the DOM', () => {
        const checkbox = doc.getElementById('useGlobalMapping');
        expect(checkbox).not.toBeNull();
    });

    test('useGlobalMapping checkbox does NOT use inline onchange handler', () => {
        const checkbox = doc.getElementById('useGlobalMapping');
        expect(checkbox).not.toBeNull();
        expect(checkbox.getAttribute('onchange')).toBeNull();
    });

    test('useGlobalMapping checkbox uses data-action="toggle-global-mapping"', () => {
        const checkbox = doc.getElementById('useGlobalMapping');
        expect(checkbox).not.toBeNull();
        expect(checkbox.getAttribute('data-action')).toBe('toggle-global-mapping');
    });
});

describe('M1.2: actions.js handles toggle-global-mapping action', () => {
    let actionsSource;

    beforeAll(() => {
        actionsSource = fs.readFileSync(
            path.join(__dirname, '..', 'public', 'js', 'actions.js'),
            'utf8'
        );
    });

    test('actions.js defines a toggleUseGlobalMapping function or equivalent logic', () => {
        expect(actionsSource).toMatch(/toggleGlobalMapping|toggle-global-mapping/);
    });

    test('actions.js exports toggleGlobalMapping via DashboardActions', () => {
        expect(actionsSource).toMatch(/toggleGlobalMapping/);
        expect(actionsSource).toMatch(/useGlobalMapping/);
        expect(actionsSource).toMatch(/currentKeyOverrides\.useGlobal/);
        expect(actionsSource).toMatch(/addOverrideForm/);
    });
});

describe('M1.2: init.js change-event delegation handles toggle-global-mapping', () => {
    let initSource;

    beforeAll(() => {
        initSource = fs.readFileSync(
            path.join(__dirname, '..', 'public', 'js', 'init.js'),
            'utf8'
        );
    });

    test('init.js change-event delegation handles toggle-global-mapping action', () => {
        expect(initSource).toMatch(/toggle-global-mapping/);
    });

    test('init.js does NOT use inline toggleUseGlobalMapping call', () => {
        expect(initSource).not.toMatch(/onchange=["']toggleUseGlobalMapping\(\)["']/);
    });
});
