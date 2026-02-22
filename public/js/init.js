/**
 * init.js — DOMContentLoaded handler, page switching, event delegation,
 * theme toggle, keyboard shortcuts, and all remaining initialization logic.
 * Phase 6: Split from dashboard.js
 *
 * Provides: window.DashboardInit
 * This module must load LAST as it depends on all other modules.
 */
(function(window) {
    'use strict';

    var DS = window.DashboardStore;
    var STATE = DS.STATE;
    var TIME_RANGES = DS.TIME_RANGES;
    var VALID_RANGES = DS.VALID_RANGES;
    var FEATURES = DS.FEATURES;
    var escapeHtml = DS.escapeHtml;
    var formatTimestamp = DS.formatTimestamp;
    var renderEmptyState = DS.renderEmptyState;
    var categorizeError = DS.categorizeError;
    var getErrorMessage = DS.getErrorMessage;
    var safeParseJson = DS.safeParseJson;
    var capitalize = DS.capitalize;
    var fetchJSON = DS.fetchJSON;
    var showToast = window.showToast;
    var errorBoundary = window.DashboardErrorBoundary?.errorBoundary;

    // Note: Interval IDs are managed in data.js. init.js calls DashboardData.cleanup() for them.
    var authIntervalId = null;  // Only authIntervalId is managed here

    var LIVE_PANEL_SCOPE_KEY = 'dashboard-live-panel-scope';
    var LIVE_PANEL_HEIGHT_KEY = 'dashboard-live-panel-height';
    var LIVE_PANEL_COMPACT_KEY = 'dashboard-live-panel-compact';
    var SCREENSHOT_QUERY_PARAM = 'screenshot';

    function formatDetailNumber(value) {
        var num = Number(value);
        if (!Number.isFinite(num)) return '0';
        return num.toLocaleString();
    }

    // ========== THEME TOGGLE ==========
    var SVG_ICON_SUN = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
    var SVG_ICON_MOON = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

    function toggleTheme() {
        var currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        var newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', newTheme);
        STATE.settings.theme = newTheme;
        var themeIcon = document.getElementById('themeIcon');
        if (themeIcon) themeIcon.innerHTML = newTheme === 'dark' ? SVG_ICON_SUN : SVG_ICON_MOON;
        localStorage.setItem('dashboard-theme', newTheme);
        if (window.DashboardData && window.DashboardData.updateChartTheme) window.DashboardData.updateChartTheme(newTheme);
        showToast('Theme changed to ' + newTheme, 'success');
    }

    function loadTheme() {
        var savedTheme = localStorage.getItem('dashboard-theme') || 'dark';
        if (savedTheme !== 'dark') {
            document.documentElement.setAttribute('data-theme', savedTheme);
            STATE.settings.theme = savedTheme;
            var themeIcon = document.getElementById('themeIcon');
            if (themeIcon) themeIcon.innerHTML = savedTheme === 'dark' ? SVG_ICON_SUN : SVG_ICON_MOON;
        }
    }

    // ========== DENSITY TOGGLE ==========
    function setDensity(density) {
        STATE.settings.density = density;
        document.body.classList.remove('density-compact', 'density-comfortable', 'density-spacious');
        document.body.classList.add('density-' + density);
        document.querySelectorAll('.density-btn').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.density === density);
        });
        localStorage.setItem('dashboard-density', density);
        if (window.HeaderResponsive && window.HeaderResponsive.refreshLayout) {
            window.HeaderResponsive.refreshLayout();
        }
    }

    function loadDensity() {
        var savedDensity = localStorage.getItem('dashboard-density') || 'comfortable';
        setDensity(savedDensity);
    }

    // ========== TAB ORDERING ==========
    var DEFAULT_TAB_ORDERING = { live: 'desc', traces: 'desc', logs: 'asc', circuit: 'desc' };
    var ORDERING_LABELS = { desc: 'Newest at top \u2193', asc: 'Newest at bottom \u2193' };

    function getTabOrdering(tabId) {
        var config = safeParseJson(localStorage.getItem('dashboard-tab-ordering'), Object.assign({}, DEFAULT_TAB_ORDERING));
        return config[tabId] || DEFAULT_TAB_ORDERING[tabId];
    }

    function setTabOrdering(tabId, direction) {
        var config = safeParseJson(localStorage.getItem('dashboard-tab-ordering'), Object.assign({}, DEFAULT_TAB_ORDERING));
        config[tabId] = direction;
        localStorage.setItem('dashboard-tab-ordering', JSON.stringify(config));
        STATE.settings.tabOrdering = config;
        updateOrderingIndicator(tabId, direction);
        refreshTabContent(tabId);
        showToast(capitalize(tabId) + ' ordering: ' + ORDERING_LABELS[direction], 'info');
    }

    function toggleTabOrdering(tabId) {
        var current = getTabOrdering(tabId);
        setTabOrdering(tabId, current === 'desc' ? 'asc' : 'desc');
    }

    function updateOrderingIndicator(tabId, direction) {
        var badge = document.querySelector('#tab-' + tabId + ' .ordering-indicator');
        if (!badge) return;
        badge.classList.remove('ordering-newest-top', 'ordering-newest-bottom');
        if (direction === 'desc') {
            badge.classList.add('ordering-newest-top');
            badge.textContent = 'Newest at top \u2193';
            badge.title = 'Click to reverse. Current: newest at top';
            badge.setAttribute('aria-pressed', 'true');
        } else {
            badge.classList.add('ordering-newest-bottom');
            badge.textContent = 'Newest at bottom \u2193';
            badge.title = 'Click to reverse. Current: newest at bottom';
            badge.setAttribute('aria-pressed', 'false');
        }
        if (tabId === 'logs' && direction === 'asc') {
            var dot = document.createElement('span');
            dot.className = 'autoscroll-dot';
            badge.appendChild(dot);
        }
    }

    function loadTabOrdering() {
        var config = safeParseJson(localStorage.getItem('dashboard-tab-ordering'), Object.assign({}, DEFAULT_TAB_ORDERING));
        STATE.settings.tabOrdering = config;
        Object.keys(config).forEach(function(tabId) {
            updateOrderingIndicator(tabId, config[tabId]);
        });
    }

    function refreshTabContent(tabId) {
        switch (tabId) {
            case 'table':
                if (window.DashboardSSE?.updateRecentRequestsTable) window.DashboardSSE.updateRecentRequestsTable();
                break;
            case 'live':
                var vp = document.querySelector('.virtual-scroll-viewport');
                if (vp) vp.scrollTop = 0;
                if (window.DashboardSSE?.scheduleVirtualRender) window.DashboardSSE.scheduleVirtualRender();
                break;
            case 'traces':
                if (typeof window.updateTracesTable === 'function') window.updateTracesTable();
                break;
        }
    }

    // ========== TIME RANGE SELECTOR ==========
    var timeRangeChangeTimeout = null;

    function setTimeRange(range, updateUrl) {
        if (updateUrl === undefined) updateUrl = true;
        if (!VALID_RANGES.includes(range)) range = '1h';
        STATE.settings.timeRange = range;

        document.querySelectorAll('.time-range-btn').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.range === range);
        });

        var label = TIME_RANGES[range].label;
        var el1 = document.getElementById('chartTimeLabel');
        var el2 = document.getElementById('chartTimeLabel2');
        var el3 = document.getElementById('chartTimeLabel3');
        if (el1) el1.textContent = label;
        if (el2) el2.textContent = label;
        if (el3) el3.textContent = label;

        if (updateUrl) {
            var url = new URL(window.location);
            url.searchParams.set('range', range);
            window.history.replaceState({}, '', url);
        }

        if (timeRangeChangeTimeout) clearTimeout(timeRangeChangeTimeout);
        timeRangeChangeTimeout = setTimeout(function() {
            // Delegate to data.js which owns the fetch intervals and controllers
            if (window.DashboardData && window.DashboardData.onTimeRangeChanged) {
                window.DashboardData.onTimeRangeChanged(range);
            }
        }, 100);

        showToast('Time range set to ' + range, 'info');
    }

    function initTimeRangeFromUrl() {
        var urlParams = new URLSearchParams(window.location.search);
        var range = urlParams.get('range');
        if (range && VALID_RANGES.includes(range)) setTimeRange(range, false);
    }

    function loadScreenshotModeFromUrl() {
        var urlParams = new URLSearchParams(window.location.search);
        var value = (urlParams.get(SCREENSHOT_QUERY_PARAM) || '').toLowerCase();
        var enabled = value === '1' || value === 'true' || value === 'docs' || value === 'full';
        STATE.settings.screenshotMode = enabled;
        document.body.classList.toggle('screenshot-mode', enabled);
    }

    // ========== TABBED INTERFACE ==========
    function switchDockTab(tabName) {
        STATE.settings.activeTab = tabName;
        document.querySelectorAll('.dock-tab').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.dockTab === tabName);
            btn.setAttribute('aria-selected', String(btn.dataset.dockTab === tabName));
            btn.setAttribute('tabindex', btn.dataset.dockTab === tabName ? '0' : '-1');
            if (btn.dataset.dockTab === tabName) {
                btn.style.background = 'var(--accent)';
                btn.style.color = '#fff';
            } else {
                btn.style.background = 'none';
                btn.style.color = 'var(--text-secondary)';
            }
        });

        document.querySelectorAll('.tab-panel').forEach(function(panel) { panel.classList.remove('active'); });
        var activePanel = document.getElementById('tab-' + tabName);
        if (activePanel) activePanel.classList.add('active');

        var titles = { live: 'Live Stream', traces: 'Request Traces', logs: 'Logs', queue: 'Queue', circuit: 'Circuit Status' };
        var titleEl = document.querySelector('.drawer-title');
        if (titleEl) titleEl.textContent = titles[tabName] || 'Live Stream';

        if (tabName === 'traces' && window.DashboardData?.loadTracesFromAPI) {
            window.DashboardData.loadTracesFromAPI();
        }
        if (tabName !== 'live') {
            setLiveCompactMore(false);
        }
        if (window.DashboardData && window.DashboardData.onTabChanged) window.DashboardData.onTabChanged(tabName);
        localStorage.setItem('dashboard-active-tab', tabName);
    }

    function switchTab(tabName) { switchDockTab(tabName); }
    function loadActiveTab() { switchTab(localStorage.getItem('dashboard-active-tab') || 'live'); }

    function selectTenant(tenantId) {
        if (window.DashboardData && window.DashboardData.selectTenant) {
            window.DashboardData.selectTenant(tenantId);
        }
    }

    function getDrawerScope() {
        return localStorage.getItem(LIVE_PANEL_SCOPE_KEY) || 'all_pages';
    }

    function setDrawerScope(scope) {
        var normalized = scope === 'requests_only' ? 'requests_only' : 'all_pages';
        localStorage.setItem(LIVE_PANEL_SCOPE_KEY, normalized);
        STATE.settings.livePanelScope = normalized;
        var toggleBtn = document.getElementById('drawerScopeToggle');
        if (toggleBtn) {
            var isAllPages = normalized === 'all_pages';
            toggleBtn.classList.toggle('active', isAllPages);
            toggleBtn.textContent = isAllPages ? 'All Pages' : 'Req Only';
            toggleBtn.setAttribute('aria-pressed', String(isAllPages));
            toggleBtn.setAttribute('title', isAllPages ? 'Visible on all pages' : 'Visible only on Requests page');
        }
    }

    function applyDrawerHeight(savedHeight) {
        var drawer = document.getElementById('bottomDrawer');
        if (!drawer) return;
        var parsed = parseInt(savedHeight || localStorage.getItem(LIVE_PANEL_HEIGHT_KEY) || '360', 10);
        var maxHeight = Math.max(240, Math.floor(window.innerHeight * 0.8));
        if (!Number.isFinite(parsed)) parsed = 360;
        var bounded = Math.min(Math.max(parsed, 220), maxHeight);
        drawer.style.setProperty('--live-panel-height', bounded + 'px');
        localStorage.setItem(LIVE_PANEL_HEIGHT_KEY, String(bounded));
        STATE.settings.livePanelHeight = bounded;
    }

    function setCompactMode(enabled) {
        var drawer = document.getElementById('bottomDrawer');
        if (!drawer) return;
        var isCompact = !!enabled;
        drawer.classList.toggle('compact-controls', isCompact);
        document.documentElement.style.setProperty('--dock-bottom', isCompact ? '30px' : '34px');
        if (!isCompact) {
            setLiveCompactMore(false);
        }
        localStorage.setItem(LIVE_PANEL_COMPACT_KEY, isCompact ? 'true' : 'false');
        STATE.settings.livePanelCompact = isCompact;
        var compactBtn = document.getElementById('drawerCompactToggle');
        if (compactBtn) {
            compactBtn.classList.toggle('active', isCompact);
            compactBtn.setAttribute('aria-pressed', String(isCompact));
        }
    }

    function setLiveCompactMore(open) {
        var tabLive = document.getElementById('tab-live');
        var moreBtn = document.getElementById('compactMoreToggle');
        var isOpen = !!open;
        if (tabLive) {
            tabLive.classList.toggle('compact-more-open', isOpen);
        }
        if (moreBtn) {
            moreBtn.classList.toggle('active', isOpen);
            moreBtn.setAttribute('aria-pressed', String(isOpen));
            moreBtn.textContent = isOpen ? 'Less' : 'More';
        }
        STATE.settings.liveCompactMoreOpen = isOpen;
    }

    function setDrawerExpanded(expanded, persist) {
        var drawer = document.getElementById('bottomDrawer');
        if (!drawer) return;
        drawer.classList.toggle('expanded', !!expanded);
        var toggleBtn = drawer.querySelector('.drawer-toggle');
        if (toggleBtn) {
            toggleBtn.innerHTML = expanded ? '\u25BC' : '\u25B2';
            toggleBtn.setAttribute('aria-expanded', String(!!expanded));
        }
        if (persist !== false) {
            localStorage.setItem('drawer-expanded', expanded ? 'true' : 'false');
        }
    }

    function isDrawerVisibleOnPage(pageName) {
        if (STATE.settings.screenshotMode) return true;
        return getDrawerScope() === 'all_pages' || pageName === 'requests';
    }

    function applyDrawerVisibility(pageName) {
        var drawer = document.getElementById('bottomDrawer');
        if (!drawer) return;
        drawer.style.display = isDrawerVisibleOnPage(pageName) ? '' : 'none';
    }

    function initDrawerPreferences() {
        setDrawerScope(getDrawerScope());
        applyDrawerHeight();
        var compactSetting = localStorage.getItem(LIVE_PANEL_COMPACT_KEY);
        setCompactMode(compactSetting === null ? true : compactSetting === 'true');
        setDrawerExpanded(localStorage.getItem('drawer-expanded') === 'true', false);
    }

    // ========== URL HASH ROUTING ==========
    // Route configuration for hash-based navigation
    var HASH_ROUTES = {
        '': { page: 'overview' },
        'overview': { page: 'overview' },
        'requests': { page: 'requests', subPage: 'table' },
        'requests/table': { page: 'requests', subPage: 'table' },
        'requests/live': { page: 'requests', subPage: 'live' },
        'requests/traces': { page: 'requests', subPage: 'traces' },
        'requests/logs': { page: 'requests', subPage: 'logs' },
        'requests/queue': { page: 'requests', subPage: 'queue' },
        'requests/circuit': { page: 'requests', subPage: 'circuit' },
        'routing': { page: 'routing' },
        'routing/observability': { page: 'routing', subPage: 'observability' },
        'routing/cooldowns': { page: 'routing', subPage: 'cooldowns' },
        'routing/overrides': { page: 'routing', subPage: 'overrides' },
        'routing/advanced': { page: 'routing', subPage: 'advanced' },
        'system': { page: 'system' }
    };

    // Flag to prevent hash change handler from re-triggering navigation
    var isNavigatingFromCode = false;

    // Initialize navigation from URL hash
    function initNavigationFromHash() {
        var hash = window.location.hash.slice(1); // Remove #
        var savedPage = localStorage.getItem('dashboard-active-page');
        var savedRequestTab = localStorage.getItem('dashboard-request-tab');
        var savedRoutingTab = localStorage.getItem('dashboard-routing-tab');

        // Priority: hash > localStorage > default
        var route = HASH_ROUTES[hash];

        if (!route && savedPage) {
            // Try to build route from localStorage
            if (savedPage === 'requests' && savedRequestTab) {
                route = HASH_ROUTES['requests/' + savedRequestTab];
            } else if (savedPage === 'routing' && savedRoutingTab) {
                route = HASH_ROUTES['routing/' + savedRoutingTab];
            } else {
                route = HASH_ROUTES[savedPage];
            }
        }

        if (!route) {
            route = HASH_ROUTES['']; // Default to overview
        }

        isNavigatingFromCode = true;
        switchPage(route.page);

        if (route.subPage) {
            if (route.page === 'requests') {
                switchRequestTab(route.subPage);
            } else if (route.page === 'routing') {
                switchRoutingTab(route.subPage);
            }
        } else if (route.page === 'requests') {
            loadActiveRequestTab();
        }

        // Update hash to reflect actual state
        updateHash(route.page, route.subPage);
        isNavigatingFromCode = false;
    }

    // Update URL hash when navigation changes
    function updateHash(page, subPage) {
        var hash = page;
        if (subPage) {
            hash = page + '/' + subPage;
        }
        // Only update if hash is different to avoid extra history entries
        if (window.location.hash.slice(1) !== hash) {
            history.replaceState(null, '', hash ? '#' + hash : window.location.pathname);
        }
    }

    // Migrate legacy localStorage state to hash
    function migrateLegacyState() {
        // Only migrate if no hash is present
        if (window.location.hash) return;

        var oldPage = localStorage.getItem('dashboard-active-page');
        var oldTab = localStorage.getItem('dashboard-request-tab');
        var oldRoutingTab = localStorage.getItem('dashboard-routing-tab');

        if (oldPage) {
            var newHash = oldPage;
            if (oldPage === 'requests' && oldTab) {
                newHash = 'requests/' + oldTab;
            } else if (oldPage === 'routing' && oldRoutingTab) {
                newHash = 'routing/' + oldRoutingTab;
            }
            history.replaceState(null, '', '#' + newHash);
        }
    }

    // Listen for hash changes (back/forward button)
    window.addEventListener('hashchange', function() {
        if (isNavigatingFromCode) return; // Prevent loop

        var hash = window.location.hash.slice(1);
        var route = HASH_ROUTES[hash];

        if (route) {
            isNavigatingFromCode = true;
            switchPage(route.page);

            if (route.subPage) {
                if (route.page === 'requests') {
                    switchRequestTab(route.subPage);
                } else if (route.page === 'routing') {
                    switchRoutingTab(route.subPage);
                }
            }
            isNavigatingFromCode = false;
        }
    });

    // ========== BREADCRUMB NAVIGATION ==========
    var PAGE_LABELS = {
        'overview': 'Overview',
        'routing': 'Routing',
        'requests': 'Requests',
        'system': 'Diagnostics'
    };

    var SUBPAGE_LABELS = {
        'requests': {
            'table': 'All Requests',
            'live': 'Live Stream',
            'traces': 'Traces',
            'logs': 'Logs',
            'queue': 'Queue',
            'circuit': 'Circuit Breaker'
        },
        'routing': {
            'tiers': 'Routing Tiers',
            'flow': 'Request Flow',
            'observability': 'Observability',
            'cooldowns': 'Cooldowns',
            'overrides': 'Overrides',
            'advanced': 'Advanced Settings'
        }
    };

    function updateBreadcrumbs() {
        var breadcrumbNav = document.getElementById('breadcrumbNav');
        if (!breadcrumbNav) return;

        var page = STATE.activePage;
        var subPage = null;

        // Get current sub-page based on active page
        if (page === 'requests') {
            var activeTab = document.querySelector('#requestsSubTabs .sub-tab.active');
            if (activeTab) subPage = activeTab.dataset.tab;
            // Don't show sub-page for default 'table' tab
            if (subPage === 'table' || subPage === 'live') subPage = null;
        } else if (page === 'routing') {
            var activeTab = document.querySelector('.routing-tab-btn.active');
            if (activeTab) subPage = activeTab.dataset.routingTab;
            // Don't show sub-page for default tab
            if (subPage === 'tiers' || subPage === 'flow') subPage = null;
        }

        // Don't show breadcrumbs for Overview (it's the root)
        if (page === 'overview') {
            breadcrumbNav.innerHTML = '';
            breadcrumbNav.classList.add('hidden');
            return;
        }

        var breadcrumbs = [];
        var pageLabel = PAGE_LABELS[page] || page;

        // Add parent page link
        breadcrumbs.push({
            label: pageLabel,
            page: page,
            subPage: null,
            active: !subPage
        });

        // Add sub-page if present and non-default
        if (subPage && SUBPAGE_LABELS[page] && SUBPAGE_LABELS[page][subPage]) {
            breadcrumbs.push({
                label: SUBPAGE_LABELS[page][subPage],
                page: page,
                subPage: subPage,
                active: true
            });
        }

        // Render breadcrumbs
        var html = '';
        breadcrumbs.forEach(function(crumb, index) {
            html += '<span class="breadcrumb-item">';
            if (index > 0) {
                html += '<span class="breadcrumb-separator">›</span>';
            }
            if (crumb.active) {
                html += '<span class="breadcrumb-link active">' + escapeHtml(crumb.label) + '</span>';
            } else {
                html += '<button class="breadcrumb-link" data-action="breadcrumb-navigate" data-page="' + crumb.page + '">' + escapeHtml(crumb.label) + '</button>';
            }
            html += '</span>';
        });

        breadcrumbNav.innerHTML = html;
        breadcrumbNav.classList.remove('hidden');
    }

    // ========== PAGE NAVIGATION ==========
    STATE.activePage = 'overview';

    function switchPage(pageName) {
        STATE.activePage = pageName;
        document.querySelectorAll('.page-nav-btn').forEach(function(btn) {
            var isActive = btn.dataset.page === pageName;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
            btn.setAttribute('tabindex', isActive ? '0' : '-1');
            if (isActive) btn.setAttribute('aria-current', 'page');
            else btn.removeAttribute('aria-current');
        });

        document.querySelectorAll('.page-section[data-belongs-to]').forEach(function(section) {
            var pages = section.dataset.belongsTo.split(' ');
            section.classList.toggle('page-hidden', !pages.includes(pageName));
        });

        applyDrawerVisibility(pageName);

        if (pageName !== 'requests') {
            setLiveCompactMore(false);
        }

        if (pageName === 'requests') loadActiveRequestTab();
        if (pageName !== 'models' && window.DashboardLiveFlow?.stopPoolPolling) window.DashboardLiveFlow.stopPoolPolling();
        localStorage.setItem('dashboard-active-page', pageName);

        // Update URL hash (unless navigating from hash change handler)
        if (!isNavigatingFromCode) {
            updateHash(pageName, null);
        }

        // Update breadcrumbs
        updateBreadcrumbs();
    }

    function loadActivePage() {
        // Use hash-based navigation instead of direct localStorage
        initNavigationFromHash();
    }

    // ========== REQUESTS PAGE SUB-TABS ==========
    function switchRequestTab(tabName) {
        document.querySelectorAll('#requestsSubTabs .sub-tab').forEach(function(t) {
            t.classList.toggle('active', t.dataset.tab === tabName);
        });
        // data-tab can be space-separated (e.g. "live traces") to match multiple tabs
        document.querySelectorAll('.request-tab-content[data-belongs-to="requests"]').forEach(function(s) {
            var sectionTab = s.dataset.tab;
            if (!sectionTab) return;
            var matchesTab = sectionTab.split(' ').indexOf(tabName) !== -1;
            s.classList.toggle('page-hidden', !matchesTab);
        });
        var DOCK_TABS = ['live', 'traces', 'logs', 'queue', 'circuit'];
        if (DOCK_TABS.indexOf(tabName) !== -1) {
            switchDockTab(tabName);
            var drawer = document.getElementById('bottomDrawer');
            if (drawer && !drawer.classList.contains('expanded')) {
                setDrawerExpanded(true);
            }
            if (tabName === 'traces' && window.DashboardData?.loadTracesFromAPI) {
                window.DashboardData.loadTracesFromAPI();
            }
        } else {
            setLiveCompactMore(false);
        }
        localStorage.setItem('dashboard-request-tab', tabName);

        // Update URL hash (unless navigating from hash change handler)
        if (!isNavigatingFromCode && STATE.activePage === 'requests') {
            updateHash('requests', tabName);
        }

        // Update breadcrumbs
        updateBreadcrumbs();
    }

    function loadActiveRequestTab() {
        switchRequestTab(localStorage.getItem('dashboard-request-tab') || 'table');
    }

    // ========== ROUTING PAGE TABS ==========
    function switchRoutingTab(tabName) {
        document.querySelectorAll('.routing-tab-btn').forEach(function(btn) {
            var isActive = btn.dataset.routingTab === tabName;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
            btn.setAttribute('tabindex', isActive ? '0' : '-1');
        });
        document.querySelectorAll('.routing-tab-panel').forEach(function(panel) {
            panel.classList.toggle('active', panel.dataset.routingPanel === tabName);
        });
        localStorage.setItem('dashboard-routing-tab', tabName);
        if (tabName === 'observability') {
            if (STATE.charts.routingTier) STATE.charts.routingTier.resize();
            if (STATE.charts.routingSource) STATE.charts.routingSource.resize();
            if (STATE.charts.routing429) STATE.charts.routing429.resize();
        }

        // Update URL hash (unless navigating from hash change handler)
        if (!isNavigatingFromCode && STATE.activePage === 'routing') {
            updateHash('routing', tabName);
        }

        // Update breadcrumbs
        updateBreadcrumbs();
    }

    // ========== KEYBOARD SHORTCUTS ==========
    function showShortcutsModal() {
        var modal = document.getElementById('shortcutsModal');
        if (modal) {
            modal.classList.add('visible');
            setupFocusTrap(modal);
        }
    }
    function closeShortcutsModal(e) {
        if (e.target.id === 'shortcutsModal' || e.key === 'Escape') {
            var modal = document.getElementById('shortcutsModal');
            if (modal) {
                modal.classList.remove('visible');
                // Return focus to the element that opened the modal
                if (modal._previousActiveElement) {
                    modal._previousActiveElement.focus();
                }
            }
        }
    }

    // ========== FOCUS TRAP UTILITY ==========
    var focusTrapHandlers = new WeakMap();

    function setupFocusTrap(modal) {
        // Store the currently focused element so we can return to it
        modal._previousActiveElement = document.activeElement;

        // Find all focusable elements within the modal
        var focusableElements = modal.querySelectorAll(
            'a[href], button:not([disabled]), textarea:not([disabled]), ' +
            'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        var firstElement = focusableElements[0];
        var lastElement = focusableElements[focusableElements.length - 1];

        // Focus the first element if nothing is focused within the modal
        if (!modal.contains(document.activeElement)) {
            if (firstElement) firstElement.focus();
        }

        // Set up the trap handler
        var trapHandler = function(e) {
            if (e.key !== 'Tab') return;

            // If Shift+Tab on first element, move to last
            if (e.shiftKey && document.activeElement === firstElement) {
                e.preventDefault();
                if (lastElement) lastElement.focus();
            }
            // If Tab on last element, move to first
            else if (!e.shiftKey && document.activeElement === lastElement) {
                e.preventDefault();
                if (firstElement) firstElement.focus();
            }
        };

        // Remove any existing handler and add new one
        removeFocusTrap(modal);
        modal.addEventListener('keydown', trapHandler);
        focusTrapHandlers.set(modal, trapHandler);
    }

    function removeFocusTrap(modal) {
        var existingHandler = focusTrapHandlers.get(modal);
        if (existingHandler) {
            modal.removeEventListener('keydown', existingHandler);
            focusTrapHandlers.delete(modal);
        }
    }

    // ========== VIM-STYLE KEYBOARD SHORTCUTS ==========
    var vimShortcutPending = null;
    var vimShortcutTimer = null;

    function handleVimShortcut(key) {
        // Clear any pending timer
        if (vimShortcutTimer) {
            clearTimeout(vimShortcutTimer);
            vimShortcutTimer = null;
        }

        if (vimShortcutPending === null) {
            // First key - start pending sequence
            vimShortcutPending = key;
            vimShortcutTimer = setTimeout(function() {
                // Reset if no second key pressed within 1 second
                vimShortcutPending = null;
            }, 1000);
        } else {
            // Second key - execute navigation
            var firstKey = vimShortcutPending;
            vimShortcutPending = null;

            if (firstKey === 'g') {
                switch(key) {
                    case 'o': // Overview
                        switchPage('overview');
                        break;
                    case 'c': // Routing
                        switchPage('routing');
                        break;
                    case 'r': // Requests
                        switchPage('requests');
                        break;
                    case 'd': // Diagnostics (formerly System)
                        switchPage('system');
                        break;
                    case 'l': // Live
                        switchPage('requests');
                        requestAnimationFrame(function() { switchRequestTab('live'); });
                        break;
                    case 't': // Traces
                        switchPage('requests');
                        requestAnimationFrame(function() { switchRequestTab('traces'); });
                        break;
                    case 's': // System/Diagnostics
                        switchPage('system');
                        break;
                }
                var navLabels = {
                    'o': 'Overview', 'c': 'Routing', 'r': 'Requests',
                    'd': 'Diagnostics', 'l': 'Live', 't': 'Traces', 's': 'System'
                };
                if (window.showToast && navLabels[key]) {
                    window.showToast('Navigated to ' + navLabels[key], 'success');
                }
            }
        }
    }

    function handleKeyboardShortcuts(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // Arrow key navigation for tablists
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            var tablist = document.activeElement ? document.activeElement.closest('[role="tablist"]') : null;
            if (tablist) {
                e.preventDefault();
                var tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
                var currentIdx = tabs.indexOf(document.activeElement);
                if (currentIdx === -1) return;
                var nextIdx = e.key === 'ArrowRight' ? (currentIdx + 1) % tabs.length : (currentIdx - 1 + tabs.length) % tabs.length;
                tabs[nextIdx].focus();
                tabs[nextIdx].click();
                return;
            }
        }

        // Arrow key navigation for request list (up/down)
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && STATE.activePage === 'requests') {
            var requestList = document.getElementById('liveStreamRequestList');
            if (requestList && (document.activeElement === null || document.activeElement === document.body || requestList.contains(document.activeElement))) {
                e.preventDefault();
                var direction = e.key === 'ArrowDown' ? 1 : -1;
                if (window.DashboardFilters && window.DashboardFilters.navigateRequestList) {
                    window.DashboardFilters.navigateRequestList(direction);
                }
                return;
            }
        }

        var key = e.key.toLowerCase();

        // Ctrl+F - Focus status filter
        if ((e.ctrlKey || e.metaKey) && key === 'f') {
            e.preventDefault();
            var statusFilter = document.querySelector('[data-filter-type="status"], .status-filter-select, select[name="status"]');
            if (statusFilter) {
                statusFilter.focus();
                if (statusFilter.tagName === 'SELECT') statusFilter.click();
                showToast('Status filter focused', 'info');
            }
            return;
        }

        // Ctrl+M - Focus model filter
        if ((e.ctrlKey || e.metaKey) && key === 'm') {
            e.preventDefault();
            var modelFilter = document.querySelector('[data-filter-type="model"], .model-filter-select, select[name="model"]');
            if (modelFilter) {
                modelFilter.focus();
                if (modelFilter.tagName === 'SELECT') modelFilter.click();
                showToast('Model filter focused', 'info');
            }
            return;
        }

        // Ctrl+S - Focus search input (alternative to Ctrl+K)
        if ((e.ctrlKey || e.metaKey) && key === 's') {
            e.preventDefault();
            var searchInput = document.getElementById('globalSearchInput');
            if (searchInput) {
                searchInput.focus();
                searchInput.select();
            }
            return;
        }

        // Ctrl+D - Focus density selector
        if ((e.ctrlKey || e.metaKey) && key === 'd') {
            e.preventDefault();
            var densityToggle = document.querySelector('.density-toggle-inline, [data-testid="density-toggle"]');
            if (densityToggle) {
                densityToggle.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                showToast('Use C to cycle density options', 'info');
            }
            return;
        }

        if (key >= '1' && key <= '2' && STATE.activePage === 'requests') {
            e.preventDefault();
            var reqTabs = ['live', 'traces'];
            var tabIndex = parseInt(key) - 1;
            if (reqTabs[tabIndex]) switchRequestTab(reqTabs[tabIndex]);
            return;
        }

        if (e.key === 'C') {
            e.preventDefault();
            var currentIndex = STATE.densityOptions.indexOf(STATE.settings.density);
            var nextIndex = (currentIndex + 1) % STATE.densityOptions.length;
            setDensity(STATE.densityOptions[nextIndex]);
            showToast('Density: ' + STATE.densityOptions[nextIndex], 'info');
            return;
        }

        switch(key) {
            case 'j': e.preventDefault(); if (window.DashboardFilters) window.DashboardFilters.navigateRequestList(1); break;
            case 'k': e.preventDefault(); if (window.DashboardFilters) window.DashboardFilters.navigateRequestList(-1); break;
            case 'enter':
                if (STATE.selectedListIndex >= 0) {
                    e.preventDefault();
                    var rows = document.querySelectorAll('#liveStreamRequestList .request-row');
                    if (rows[STATE.selectedListIndex]) {
                        var requestId = rows[STATE.selectedListIndex].dataset.requestId;
                        if (requestId) openSidePanel(requestId);
                    }
                }
                break;
            case 'p': if (window.DashboardData && window.DashboardData.controlAction) { window.DashboardData.controlAction(STATE.settings.paused ? 'resume' : 'pause'); } break;
            case 'r': if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); if (window.DashboardSSE?.updateRecentRequestsTable) window.DashboardSSE.updateRecentRequestsTable(); showToast('Data refreshed', 'info'); } break;
            case 't': e.preventDefault(); toggleTheme(); break;
            case 'e': e.preventDefault(); if (window.DashboardData && window.DashboardData.exportData) { window.DashboardData.exportData(); } break;
            case 'l': e.preventDefault(); switchPage('requests'); switchRequestTab('live'); break;
            case '?': e.preventDefault(); showShortcutsModal(); break;
            case 'escape':
                if (STATE.selectedRequestId) { closeSidePanel(); return; }
                // Close any open modals
                document.querySelectorAll('.modal-overlay.visible, #shortcutsModal.visible').forEach(function(modal) {
                    modal.classList.remove('visible');
                });
                // Close fullscreen charts
                document.querySelectorAll('.chart-container.fullscreen').forEach(function(el) { el.classList.remove('fullscreen'); });
                // Close side panel
                closeSidePanel();
                closeShortcutsModal({ target: { id: 'shortcutsModal' }, key: 'Escape' });
                break;
        }
    }

    // ========== SIDE PANEL ==========
    function openSidePanel(requestId) {
        if (!requestId) return;
        DS.store.dispatch(DS.Actions.selectRequest(requestId));
        document.querySelectorAll('#liveStreamRequestList .request-row.selected').forEach(function(row) {
            row.classList.remove('selected');
        });
        var requestSelectorId = String(requestId);
        if (window.CSS && typeof window.CSS.escape === 'function') {
            requestSelectorId = window.CSS.escape(requestSelectorId);
        } else {
            requestSelectorId = requestSelectorId.replace(/["\\]/g, '\\$&');
        }
        var selectedRow = document.querySelector('#liveStreamRequestList .request-row[data-request-id="' + requestSelectorId + '"]');
        if (selectedRow) selectedRow.classList.add('selected');
        var panel = document.getElementById('sidePanel');
        var backdrop = document.getElementById('sidePanelBackdrop');
        if (panel) panel.classList.add('open');
        if (backdrop) backdrop.classList.add('visible');
        renderRequestDetails(requestId);
    }

    function closeSidePanel() {
        DS.store.dispatch(DS.Actions.selectRequest(null));
        document.querySelectorAll('#liveStreamRequestList .request-row.selected').forEach(function(row) {
            row.classList.remove('selected');
        });
        var panel = document.getElementById('sidePanel');
        var backdrop = document.getElementById('sidePanelBackdrop');
        if (panel) panel.classList.remove('open');
        if (backdrop) backdrop.classList.remove('visible');
    }

    function renderMessageContentSection(request) {
        function extractMessageText(value) {
            if (value == null) return '';
            if (typeof value === 'string') return value.trim();
            if (Array.isArray(value)) {
                var parts = [];
                for (var ai = 0; ai < value.length; ai++) {
                    var part = extractMessageText(value[ai]);
                    if (part) parts.push(part);
                }
                return parts.join('\n\n').trim();
            }
            if (typeof value === 'object') {
                if (typeof value.text === 'string') return value.text.trim();
                if (typeof value.input === 'string') return value.input.trim();
                if (typeof value.content === 'string') return value.content.trim();
                if (Array.isArray(value.content)) return extractMessageText(value.content);
                return '';
            }
            return '';
        }

        function deriveContentFromPayload() {
            var payloadJson = request?.requestPayload?.json;
            if (!payloadJson || typeof payloadJson !== 'string') return null;
            var parsed;
            try {
                parsed = JSON.parse(payloadJson);
            } catch {
                return null;
            }
            if (!parsed || typeof parsed !== 'object') return null;
            var extractedMessages = [];
            var rawMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
            for (var i = 0; i < rawMessages.length; i++) {
                var raw = rawMessages[i] || {};
                var text = extractMessageText(raw.content ?? raw.text ?? '');
                if (!text) continue;
                extractedMessages.push({
                    index: i,
                    role: raw.role || 'message',
                    text: text
                });
            }

            var systemText = extractMessageText(parsed.system);
            if (!systemText && extractedMessages.length === 0) return null;

            return {
                system: systemText,
                messages: extractedMessages,
                messageCount: rawMessages.length || extractedMessages.length,
                maxTokens: typeof parsed.max_tokens === 'number' ? parsed.max_tokens : undefined,
                toolsCount: Array.isArray(parsed.tools) ? parsed.tools.length : undefined,
                truncated: !!request?.requestPayload?.truncated,
                fromPayloadPreview: true
            };
        }

        var content = request.requestContent || deriveContentFromPayload();
        if (!content || (!content.system && !(Array.isArray(content.messages) && content.messages.length > 0))) {
            return '';
        }

        var section = '<div class="detail-section"><div class="detail-section-title">Message Content</div>';
        if (content.system) {
            section +=
                '<div class="detail-row detail-row--stacked">' +
                '<span class="detail-label">System</span>' +
                '<span class="detail-value"><pre class="detail-content-block">' + escapeHtml(content.system) + '</pre></span>' +
                '</div>';
        }

        if (Array.isArray(content.messages)) {
            for (var i = 0; i < content.messages.length; i++) {
                var msg = content.messages[i] || {};
                var role = msg.role || 'message';
                var idx = typeof msg.index === 'number' ? msg.index + 1 : i + 1;
                section +=
                    '<div class="detail-row detail-row--stacked">' +
                    '<span class="detail-label">Message #' + idx + ' (' + escapeHtml(role) + ')</span>' +
                    '<span class="detail-value"><pre class="detail-content-block">' + escapeHtml(extractMessageText(msg.text || msg.content || '')) + '</pre></span>' +
                    '</div>';
            }
        }

        var meta = [];
        if (typeof content.messageCount === 'number') meta.push('messages=' + content.messageCount);
        if (typeof content.maxTokens === 'number') meta.push('max_tokens=' + content.maxTokens);
        if (typeof content.toolsCount === 'number' && content.toolsCount > 0) meta.push('tools=' + content.toolsCount);
        if (content.truncated) meta.push('truncated');
        if (meta.length > 0) {
            section += '<div class="detail-row"><span class="detail-label">Content Meta</span><span class="detail-value">' + escapeHtml(meta.join(' | ')) + '</span></div>';
        }
        if (content.fromPayloadPreview) {
            section += '<div class="detail-row"><span class="detail-label">Source</span><span class="detail-value">Derived from payload preview</span></div>';
        }
        section += '</div>';
        return section;
    }

    function renderRawPayloadSection(request) {
        var payload = request.requestPayload;
        var payloadJson = payload && payload.json ? payload.json : '';
        var hasPayload = !!payloadJson;
        var canLoadFull = !!request.requestPayloadAvailable && !!request.requestId && !request.requestPayloadLoaded;
        if (!hasPayload && !canLoadFull) return '';

        var meta = [];
        if (payload && payload.truncated) meta.push(request.requestPayloadLoaded ? 'full payload truncated' : 'preview truncated');
        if (request.requestPayloadLoaded) meta.push('full payload loaded');
        var metaLine = meta.length
            ? '<div class="detail-row"><span class="detail-label">Payload Meta</span><span class="detail-value">' + escapeHtml(meta.join(' | ')) + '</span></div>'
            : '';
        var loadButton = canLoadFull
            ? '<button class="btn btn-secondary btn-small detail-action-btn" data-action="load-request-payload" data-request-id="' + escapeHtml(request.requestId) + '" id="loadRequestPayloadBtn">Load Full</button>'
            : '';
        var toggleButton = hasPayload
            ? '<button class="btn btn-secondary btn-small detail-action-btn" data-action="toggle-request-payload" id="toggleRequestPayloadBtn">Show JSON</button>'
            : '';
        var copyButton = hasPayload
            ? '<button class="btn btn-secondary btn-small detail-action-btn" data-action="copy-request-payload">Copy</button>'
            : '';
        var payloadBlock = hasPayload
            ? '<div class="detail-payload-view is-hidden" id="requestPayloadView">' +
                '<pre class="detail-content-block detail-content-block--json" id="requestPayloadPre">' + escapeHtml(payloadJson) + '</pre>' +
            '</div>'
            : '<div class="detail-row"><span class="detail-label">Payload</span><span class="detail-value">No payload preview captured. Use Load Full.</span></div>';

        return '' +
            '<div class="detail-section detail-section--payload">' +
                '<div class="detail-section-title detail-section-title--actions">' +
                    '<span>Raw Request Payload</span>' +
                    '<span class="detail-title-actions">' +
                        loadButton +
                        toggleButton +
                        copyButton +
                    '</span>' +
                '</div>' +
                payloadBlock +
                metaLine +
            '</div>';
    }

    function renderRequestDetails(requestId) {
        var body = document.getElementById('sidePanelBody');
        if (!body) return;
        var targetId = String(requestId);
        var request = STATE.requestsHistory.find(function(r) {
            var rowId = r.requestId || r.traceId || r.id || (r.timestamp + '-' + (r.keyIndex ?? 0));
            return String(rowId) === targetId;
        });
        if (!request) {
            body.innerHTML = '<div style="color: var(--text-secondary);">Request not found in the current live buffer.</div>';
            return;
        }
        try {
            var statusCode = request.status || (request.error ? 500 : 200);
            var statusClass = statusCode >= 400 ? 'error' : statusCode >= 300 ? 'warning' : 'success';
            var copyBtn = function(value) {
                return value && value !== 'N/A'
                    ? '<button class="copy-btn" data-action="copy-value" data-value="' + escapeHtml(String(value)) + '" title="Copy">\uD83D\uDCCB</button>'
                    : '';
            };

            var detailsHtml =
                '<div class="detail-row"><span class="detail-label">Request ID</span><span class="detail-value">' + escapeHtml(targetId) + copyBtn(targetId) + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Timestamp</span><span class="detail-value">' + formatTimestamp(request.timestamp, {full: true}) + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Model</span><span class="detail-value">' + escapeHtml(request.originalModel || request.model || 'N/A') + copyBtn(request.originalModel || request.model) + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Mapped To</span><span class="detail-value">' + escapeHtml(request.mappedModel || 'N/A') + copyBtn(request.mappedModel) + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Status</span><span class="detail-value" style="color: var(--' + statusClass + ')">' + statusCode + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Latency</span><span class="detail-value">' + (request.latency || request.latencyMs || 'N/A') + 'ms</span></div>' +
                '<div class="detail-row"><span class="detail-label">Key</span><span class="detail-value">K' + (request.keyIndex ?? 'N/A') + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Retries</span><span class="detail-value">' + (request.retries ?? 0) + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Streaming</span><span class="detail-value">' + (request.streaming ? 'Yes' : 'No') + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Path</span><span class="detail-value">' + escapeHtml(request.path || '/v1/messages') + '</span></div>' +
                (request.inputTokens || request.outputTokens
                    ? '<div class="detail-row"><span class="detail-label">Input Tokens</span><span class="detail-value">' + formatDetailNumber(request.inputTokens || 0) + '</span></div>' +
                      '<div class="detail-row"><span class="detail-label">Output Tokens</span><span class="detail-value">' + formatDetailNumber(request.outputTokens || 0) + '</span></div>' +
                      '<div class="detail-row"><span class="detail-label">Total Tokens</span><span class="detail-value">' + formatDetailNumber((request.inputTokens || 0) + (request.outputTokens || 0)) + '</span></div>'
                    : '') +
                (request.cost && request.cost.total > 0
                    ? '<div class="detail-row"><span class="detail-label">Cost</span><span class="detail-value" style="color: var(--warning)">$' + request.cost.total.toFixed(6) + '</span></div>' +
                      '<div class="detail-row"><span class="detail-label">Input Cost</span><span class="detail-value">$' + (request.cost.inputCost || 0).toFixed(6) + ' <span class="text-secondary">@ $' + (request.cost.inputRate || 0) + '/1M</span></span></div>' +
                      '<div class="detail-row"><span class="detail-label">Output Cost</span><span class="detail-value">$' + (request.cost.outputCost || 0).toFixed(6) + ' <span class="text-secondary">@ $' + (request.cost.outputRate || 0) + '/1M</span></span></div>'
                    : '') +
                (request.error || request.errorType
                    ? '<div class="detail-row"><span class="detail-label">Error</span><span class="detail-value" style="color: var(--error)">' + escapeHtml(request.errorType || request.error) + '</span></div>'
                    : '');
            var contentHtml = renderMessageContentSection(request);
            var payloadHtml = renderRawPayloadSection(request);
            body.innerHTML = detailsHtml + contentHtml + payloadHtml;
        } catch (err) {
            console.error('Failed to render request details', { requestId: targetId, error: err });
            body.innerHTML = '<div style="color: var(--error);">Failed to render request details. Check browser console for details.</div>';
        }
    }

    window.openSidePanel = openSidePanel;

    // ========== AUTH STATE ==========
    var AUTH_STATE = { enabled: false, tokensConfigured: 0, tokensRequired: false, authenticated: false, token: null };

    async function fetchAuthStatus() {
        var data = await fetchJSON('/auth-status');
        if (data) {
            AUTH_STATE.enabled = data.enabled;
            AUTH_STATE.tokensConfigured = data.tokensConfigured;
            AUTH_STATE.tokensRequired = data.tokensRequired;
            AUTH_STATE.authenticated = data.authenticated;
            updateAuthUI();
        }
    }

    function updateAuthUI() {
        var authBadge = document.getElementById('authBadge');
        if (authBadge) {
            if (!AUTH_STATE.enabled) {
                authBadge.className = 'auth-badge disabled'; authBadge.textContent = 'Auth Disabled';
            } else if (AUTH_STATE.authenticated) {
                authBadge.className = 'auth-badge authenticated'; authBadge.textContent = 'Admin Unlocked';
            } else if (AUTH_STATE.tokensRequired) {
                authBadge.className = 'auth-badge required'; authBadge.textContent = 'Read-Only';
            } else {
                authBadge.className = 'auth-badge open'; authBadge.textContent = 'Open Access';
            }
        }
        var shouldDisable = AUTH_STATE.enabled && AUTH_STATE.tokensRequired && !AUTH_STATE.authenticated;
        document.querySelectorAll('[data-admin="true"]').forEach(function(el) { el.disabled = shouldDisable; });
        var loginBtn = document.getElementById('loginBtn');
        var logoutBtn = document.getElementById('logoutBtn');
        if (loginBtn) loginBtn.style.display = AUTH_STATE.tokensRequired && !AUTH_STATE.authenticated ? 'inline-flex' : 'none';
        if (logoutBtn) logoutBtn.style.display = AUTH_STATE.authenticated ? 'inline-flex' : 'none';

        // Sync overflow menu auth state
        if (window.HeaderResponsive && window.HeaderResponsive.syncAuthOverflowState) {
            window.HeaderResponsive.syncAuthOverflowState(AUTH_STATE.authenticated, AUTH_STATE.tokensRequired);
        }
    }

    function showLoginDialog() {
        var token = prompt('Enter admin token:');
        if (token === null) return;
        if (!token || token.length < 1) { showToast('Token cannot be empty', 'error'); return; }
        fetch('/auth-status', { headers: { 'x-admin-token': token } })
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.authenticated) {
                    AUTH_STATE.token = token; AUTH_STATE.authenticated = true;
                    sessionStorage.setItem('adminToken', token);
                    updateAuthUI(); showToast('Admin access granted', 'success');
                } else { showToast('Invalid admin token', 'error'); }
            }).catch(function() { showToast('Authentication failed', 'error'); });
    }

    function logout() {
        AUTH_STATE.token = null; AUTH_STATE.authenticated = false;
        sessionStorage.removeItem('adminToken'); localStorage.removeItem('adminToken');
        updateAuthUI(); showToast('Logged out', 'info');
    }

    function loadStoredToken() {
        var token = sessionStorage.getItem('adminToken') || localStorage.getItem('adminToken');
        if (token) {
            fetch('/auth-status', { headers: { 'x-admin-token': token } })
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    if (data.authenticated) { AUTH_STATE.token = token; AUTH_STATE.authenticated = true; updateAuthUI(); }
                    else { sessionStorage.removeItem('adminToken'); localStorage.removeItem('adminToken'); }
                }).catch(function() {
                    // Server unreachable — clear stale tokens
                    sessionStorage.removeItem('adminToken');
                    localStorage.removeItem('adminToken');
                });
        }
    }

    // ========== DATA FETCHING (stubs delegating to original dashboard.js functions) ==========
    // These remain in the original dashboard.js monolith for backward compatibility.
    // The init module calls them via the global scope.

    // Expose key functions for the init() call
    // (The actual implementations remain in dashboard.js which is still loaded)

    function initARIA() {
        var activePageBtn = document.querySelector('.page-nav-btn.active');
        if (activePageBtn) { activePageBtn.setAttribute('aria-selected', 'true'); activePageBtn.setAttribute('tabindex', '0'); }
        var searchInput = document.getElementById('globalSearchInput');
        if (searchInput && !searchInput.getAttribute('aria-label')) {
            searchInput.setAttribute('aria-label', 'Search requests');
            searchInput.setAttribute('aria-controls', 'searchHistoryDropdown');
        }
        document.querySelectorAll('.dock-tab').forEach(function(btn) {
            var isActive = btn.classList.contains('active');
            btn.setAttribute('aria-selected', String(isActive));
            btn.setAttribute('tabindex', isActive ? '0' : '-1');
        });
    }

    // Cleanup function
    function cleanup() {
        // Delegate interval cleanup to data.js (which manages the polling intervals)
        if (window.DashboardData && window.DashboardData.cleanup) {
            window.DashboardData.cleanup();
        }

        // Cleanup auth interval (managed here)
        if (authIntervalId) clearInterval(authIntervalId);

        if (window.DashboardSSE?.cleanup) window.DashboardSSE.cleanup();
        if (STATE.sse.eventSource) STATE.sse.eventSource.close();
        if (window._liveFlowViz) window._liveFlowViz.destroy();
        if (window._tierBuilder) window._tierBuilder.destroy();
        if (window.DashboardLiveFlow?.stopPoolPolling) window.DashboardLiveFlow.stopPoolPolling();
        if (window.DashboardTierBuilder?.stopRoutingCooldownRefresh) window.DashboardTierBuilder.stopRoutingCooldownRefresh();
    }

    // ========== EVENT DELEGATION ==========
    function bindDelegatedListeners() {
        if (window.__dashboardDelegatedListenersBound) return;
        window.__dashboardDelegatedListenersBound = true;

        // Mouse events delegation for heatmap
        document.addEventListener('mouseenter', function(event) {
            var target = event.target;
            if (target.dataset?.mouseenter === 'show-heatmap-tooltip') {
                var index = parseInt(target.dataset.keyIndexTooltip, 10);
                if (typeof window.showHeatmapTooltip === 'function') window.showHeatmapTooltip(event, index);
            }
        }, true);

        document.addEventListener('mouseleave', function(event) {
            if (event.target.dataset?.mouseleave === 'hide-heatmap-tooltip') {
                if (typeof window.hideHeatmapTooltip === 'function') window.hideHeatmapTooltip();
            }
        }, true);

        // ========== UNIFIED CLICK EVENT DELEGATION ==========
        // Single click handler for overflow menu close, routing section toggle,
        // and all data-action dispatch. Consolidates 3 former handlers into 1.
        document.addEventListener('click', function(event) {
        // Overflow menu close (dismiss when clicking outside)
        var overflowContainer = document.getElementById('overflowMenuContainer');
        if (overflowContainer && !overflowContainer.contains(event.target)) {
            var dropdown = document.getElementById('overflowMenuDropdown');
            var overflowTrigger = document.getElementById('overflowMenuTrigger');
            if (dropdown) dropdown.classList.remove('open');
            if (overflowTrigger) overflowTrigger.setAttribute('aria-expanded', 'false');
        }

        // Routing section collapsible toggle
        var toggle = event.target.closest('.routing-section-toggle');
        if (toggle) {
            var targetId = toggle.getAttribute('data-toggle');
            var content = document.getElementById(targetId);
            if (content) {
                toggle.classList.toggle('open');
                content.classList.toggle('open');
                if (content.classList.contains('open')) {
                    if (window.DashboardTierBuilder) window.DashboardTierBuilder.startRoutingCooldownRefresh();
                } else {
                    if (window.DashboardTierBuilder) window.DashboardTierBuilder.stopRoutingCooldownRefresh();
                }
            }
        }
        var element = event.target.closest('[data-action]');
        if (!element) return;

        var action = element.dataset.action;
        var DD = window.DashboardData;
        var DT = window.DashboardTierBuilder;
        var DF = window.DashboardFilters;

        // Alert Bar click handlers (special case - check closest containers)
        var target = event.target;
        if (target.closest('#alertIssuesContainer')) {
            var ribbon = document.querySelector('.health-ribbon');
            if (ribbon) ribbon.scrollIntoView({ behavior: 'smooth' });
            return;
        }
        if (target.closest('#alertCircuitsContainer')) {
            var keysSection = document.querySelector('.keys-section');
            if (keysSection) keysSection.scrollIntoView({ behavior: 'smooth' });
            return;
        }
        if (target.closest('#alertQueueContainer')) {
            var queueStats = document.querySelector('.queue-stats');
            if (queueStats) queueStats.scrollIntoView({ behavior: 'smooth' });
            return;
        }

        switch (action) {
            // ---- Navigation ----
            case 'switch-page':
                switchPage(element.dataset.page);
                break;
            case 'kpi-navigate':
                var kpiPage = element.dataset.page;
                var kpiTab = element.dataset.tab;
                if (kpiPage) {
                    switchPage(kpiPage);
                    if (kpiTab && kpiPage === 'requests') switchRequestTab(kpiTab);
                    if (kpiTab && kpiPage === 'routing') switchRoutingTab(kpiTab);
                }
                break;
            case 'breadcrumb-navigate':
                // Navigate back to parent page from sub-page
                var parentPage = element.dataset.page;
                if (parentPage) {
                    switchPage(parentPage);
                    // Reset to default sub-tab for this page
                    if (parentPage === 'requests') {
                        switchRequestTab('table');
                    } else if (parentPage === 'routing') {
                        switchRoutingTab('tiers');
                    }
                }
                break;
            case 'switch-dock-tab':
                var dockTabName = element.dataset.dockTab;
                if (dockTabName) {
                    switchDockTab(dockTabName);
                    var drawer = document.getElementById('bottomDrawer');
                    if (drawer && !drawer.classList.contains('expanded')) {
                        setDrawerExpanded(true);
                    }
                }
                break;
            case 'switch-routing-tab':
                switchRoutingTab(element.dataset.routingTab);
                break;
            case 'toggle-routing-tabs':
                var rtCollapse = document.getElementById('routingTabsCollapsible');
                var rtToggle = document.getElementById('routingTabsToggle');
                if (rtCollapse) {
                    var show = rtCollapse.style.display === 'none';
                    rtCollapse.style.display = show ? '' : 'none';
                    if (rtToggle) rtToggle.innerHTML = show ? '&#x25BE;' : '&#x25B8;';
                }
                break;
            case 'switch-request-tab':
                switchRequestTab(element.dataset.tab);
                break;
            case 'switch-tab':
                switchTab(element.dataset.tab);
                break;

            // ---- Top bar controls ----
            case 'set-time-range':
                setTimeRange(element.dataset.range);
                // Update mobile dropdown label if exists
                var dropdownLabel = document.getElementById('timeRangeDropdownLabel');
                if (dropdownLabel) dropdownLabel.textContent = element.dataset.range;
                // Update dropdown active state
                document.querySelectorAll('.time-range-dropdown-item').forEach(function(item) {
                    item.classList.toggle('active', item.dataset.range === element.dataset.range);
                    item.setAttribute('aria-selected', String(item.dataset.range === element.dataset.range));
                });
                // Close dropdown if open
                var timeDropdown = document.getElementById('timeRangeDropdown');
                var timeToggle = document.getElementById('timeRangeDropdownToggle');
                if (timeDropdown) timeDropdown.classList.remove('open');
                if (timeToggle) timeToggle.setAttribute('aria-expanded', 'false');
                if (window.HeaderResponsive && window.HeaderResponsive.refreshLayout) {
                    window.HeaderResponsive.refreshLayout();
                }
                break;
            case 'toggle-time-dropdown':
                event.preventDefault();
                var timeDropdownEl = document.getElementById('timeRangeDropdown');
                var timeToggleEl = document.getElementById('timeRangeDropdownToggle');
                if (timeDropdownEl && timeToggleEl) {
                    var isTimeOpen = timeDropdownEl.classList.toggle('open');
                    timeToggleEl.setAttribute('aria-expanded', String(isTimeOpen));
                }
                if (window.HeaderResponsive && window.HeaderResponsive.refreshLayout) {
                    window.HeaderResponsive.refreshLayout();
                }
                break;
            case 'toggle-search':
                event.preventDefault();
                var searchWrapper = document.getElementById('globalSearchInputWrapper');
                var searchToggle = document.getElementById('searchToggleBtn');
                if (searchWrapper) {
                    var isSearchOpen = searchWrapper.classList.toggle('open');
                    if (searchToggle) searchToggle.setAttribute('aria-expanded', String(isSearchOpen));
                    if (isSearchOpen) {
                        var searchInput = document.getElementById('globalSearchInput');
                        if (searchInput) searchInput.focus();
                    }
                }
                if (window.HeaderResponsive && window.HeaderResponsive.refreshLayout) {
                    window.HeaderResponsive.refreshLayout();
                }
                break;
            case 'toggle-theme':
                toggleTheme();
                break;
            case 'set-density':
                setDensity(element.dataset.density);
                break;
            case 'export-data':
                if (DD && DD.exportData) DD.exportData();
                break;
            case 'share-url':
                if (DD && DD.shareURL) DD.shareURL();
                break;
            case 'show-shortcuts-modal':
                showShortcutsModal();
                break;
            case 'show-login':
                showLoginDialog();
                break;
            case 'logout':
                logout();
                break;
            case 'control-pause':
                if (DD && DD.controlAction) DD.controlAction('pause');
                break;
            case 'control-resume':
                if (DD && DD.controlAction) DD.controlAction('resume');
                break;

            // ---- Key management ----
            case 'reload-keys':
                if (DD && DD.reloadKeys) DD.reloadKeys();
                break;
            case 'select-key':
                var keyIdx = parseInt(element.dataset.keyIndex, 10);
                if (!isNaN(keyIdx) && DD && DD.selectKey) DD.selectKey(keyIdx);
                break;
            case 'close-key-details':
                if (DD && DD.closeKeyDetails) DD.closeKeyDetails();
                break;
            case 'force-circuit':
                if (DD && DD.forceCircuit) DD.forceCircuit(element.dataset.state);
                break;
            case 'force-circuit-state':
                if (DD && DD.forceCircuitState) DD.forceCircuitState(element.dataset.state);
                break;
            case 'open-key-override-modal':
                if (DD && DD.openKeyOverrideModal) DD.openKeyOverrideModal(STATE.selectedKeyIndex);
                break;
            case 'close-key-override-modal':
                if (DD && DD.closeKeyOverrideModal) DD.closeKeyOverrideModal();
                break;
            case 'add-override':
                if (DD && DD.addOverride) DD.addOverride();
                break;
            case 'save-key-overrides':
                if (DD && DD.saveKeyOverrides) DD.saveKeyOverrides();
                break;
            case 'remove-override':
                if (DD && DD.removeOverride) DD.removeOverride(element.dataset.claude);
                break;

            // ---- Stats & diagnostics ----
            case 'reset-stats':
                if (DD && DD.resetStats) DD.resetStats();
                break;
            case 'clear-logs':
                if (DD && DD.clearLogs) DD.clearLogs();
                break;
            case 'reset-all-circuits':
                if (DD && DD.resetAllCircuits) DD.resetAllCircuits();
                break;
            case 'clear-queue':
                if (DD && DD.clearQueue) DD.clearQueue();
                break;
            case 'export-diagnostics':
                if (DD && DD.exportDiagnostics) DD.exportDiagnostics();
                break;
            case 'toggle-fullscreen':
                if (DD && DD.toggleFullscreen) DD.toggleFullscreen(element.dataset.chart);
                break;

            // ---- Account details & chart nav ----
            case 'toggle-account-details':
                if (DD && DD.toggleAccountDetails) DD.toggleAccountDetails();
                break;
            case 'chart-nav':
                if (DD && DD.navigateAccountChart) {
                    DD.navigateAccountChart(element.dataset.chart, element.dataset.dir);
                }
                break;

            // ---- Issues ----
            case 'dismiss-issues':
                if (DD && DD.dismissIssues) DD.dismissIssues();
                break;
            case 'handle-issue-action':
                var issueAction = element.dataset.issueAction;
                var issueData = parseInt(element.dataset.issueData, 10);
                if (issueAction === 'resetCircuit' && DD && DD.forceCircuitState) {
                    fetch('/api/circuit/' + issueData, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ state: 'CLOSED' })
                    }).then(function() { if (DD && DD.fetchStats) DD.fetchStats(); })
                    .catch(function(err) { console.error('Reset circuit failed:', err); });
                }
                break;
            case 'reopen-issues':
                localStorage.removeItem('issues-dismissed');
                var reopenBadge = document.getElementById('issuesReopenBadge');
                if (reopenBadge) reopenBadge.style.display = 'none';
                if (DD && DD.fetchStats) DD.fetchStats();
                break;

            // ---- Modals ----
            case 'close-modal':
                if (element.dataset.modal === 'shortcuts') closeShortcutsModal(event);
                if (element.dataset.modal === 'key-override' && DD && DD.closeKeyOverrideModal) DD.closeKeyOverrideModal(event);
                break;
            case 'close-toast':
                if (event.target.parentElement) event.target.parentElement.remove();
                break;

            // ---- Filters ----
            case 'filter-change':
                if (DF && DF.applyFilters) DF.applyFilters();
                break;
            case 'clear-filters':
                if (DF && DF.clearFilters) DF.clearFilters();
                break;
            case 'toggle-autoscroll':
                if (DF && DF.toggleAutoScroll) DF.toggleAutoScroll();
                break;
            case 'jump-to-latest':
                if (DF && DF.jumpToLatest) DF.jumpToLatest();
                break;
            case 'toggle-ordering':
                var tabId = element.dataset.tab || 'live';
                toggleTabOrdering(tabId);
                break;
            case 'copy-value':
                if (DF && DF.copyToClipboard) DF.copyToClipboard(element.dataset.value, element);
                break;

            // ---- Traces ----
            case 'load-traces':
                if (DD && DD.loadTracesFromAPI) DD.loadTracesFromAPI();
                break;
            case 'trace-filter-change':
                if (DD && DD.loadTracesFromAPI) DD.loadTracesFromAPI();
                break;
            case 'show-trace':
                if (DD && DD.showTraceDetail) DD.showTraceDetail(element.dataset.traceId);
                break;
            case 'close-trace-detail':
                if (DD && DD.closeTraceDetail) DD.closeTraceDetail();
                break;
            case 'trace-search':
                if (DD && DD.searchTraceById) DD.searchTraceById();
                break;
            case 'export-traces':
                if (DD && DD.exportTraces) DD.exportTraces();
                break;
            case 'clear-trace-filters':
                if (DD && DD.clearTraceFilters) DD.clearTraceFilters();
                break;
            case 'copy-trace-id':
                if (DD && DD.copyTraceId) DD.copyTraceId();
                break;
            case 'copy-trace-json':
                if (DD && DD.copyTraceJson) DD.copyTraceJson();
                break;

            // ---- Routing actions ----
            case 'set-routing-time':
                if (DT && DT.setRoutingTime) DT.setRoutingTime(element.dataset.range);
                else {
                    // Inline fallback if tier-builder doesn't have setRoutingTime yet
                    var range = element.dataset.range;
                    document.querySelectorAll('#routingTimeSelector .time-range-btn').forEach(function(b) {
                        b.classList.toggle('active', b.dataset.range === range);
                    });
                    var minutes = (DT && DT.ROUTING_TIME_MINUTES && DT.ROUTING_TIME_MINUTES[range]) || 5;
                    fetch('/history?minutes=' + minutes).then(function(r) {
                        if (!r.ok) throw new Error('History fetch failed: ' + r.status);
                        return r.json();
                    }).then(function(h) {
                        if (DT && DT.updateRoutingObsKPIs) DT.updateRoutingObsKPIs(h);
                    }).catch(function(err) { console.error('Routing history fetch error:', err); });
                }
                break;
            case 'copy-routing-snapshot':
                if (DT && DT.copyRoutingSnapshot) DT.copyRoutingSnapshot(element);
                else if (DF && DF.copyToClipboard && DT && DT.getModelRoutingData) {
                    var routingData = DT.getModelRoutingData();
                    var snapshot = {
                        timestamp: new Date().toISOString(),
                        stats: routingData && routingData.stats ? routingData.stats : null,
                        cooldowns: routingData && routingData.cooldowns ? routingData.cooldowns : null,
                        config: routingData && routingData.config && routingData.config.cooldown ? { cooldown: routingData.config.cooldown } : null
                    };
                    DF.copyToClipboard(JSON.stringify(snapshot, null, 2), element);
                }
                break;
            case 'run-routing-test':
                if (DT && DT.runRoutingTest) DT.runRoutingTest();
                break;
            case 'run-explain':
                if (DT && DT.runExplain) DT.runExplain();
                break;
            case 'add-routing-override':
                if (DT && DT.addRoutingOverride) DT.addRoutingOverride();
                break;
            case 'remove-routing-override':
                if (DT && DT.removeRoutingOverride) DT.removeRoutingOverride(element.getAttribute('data-key'));
                break;
            case 'add-routing-rule':
                if (DT && DT.addRoutingRule) DT.addRoutingRule();
                break;
            case 'remove-routing-rule':
                if (DT && DT.removeRoutingRule) DT.removeRoutingRule(parseInt(element.getAttribute('data-rule-index'), 10));
                break;
            case 'save-tier':
                // When TierBuilder is active, delegate to its unified save; legacy path only runs without TierBuilder
                if (window._tierBuilder && window._tierBuilder._doSave) {
                    window._tierBuilder._doSave();
                } else if (DT && DT.saveTierConfig) {
                    DT.saveTierConfig(element.getAttribute('data-tier'));
                }
                break;
            case 'reset-model-routing':
                if (DT && DT.resetModelRouting) DT.resetModelRouting();
                break;
            case 'copy-routing-json':
                if (DT && DT.copyRoutingJson) DT.copyRoutingJson();
                break;
            case 'export-routing-json':
                if (DT && DT.exportRoutingJson) DT.exportRoutingJson();
                break;

            // ---- Drawer / Panels ----
            case 'toggle-drawer':
                var bottomDrawer = document.getElementById('bottomDrawer');
                if (bottomDrawer) {
                    setDrawerExpanded(!bottomDrawer.classList.contains('expanded'));
                }
                break;
            case 'toggle-live-panel-scope':
                event.preventDefault();
                event.stopPropagation();
                var nextScope = getDrawerScope() === 'all_pages' ? 'requests_only' : 'all_pages';
                setDrawerScope(nextScope);
                applyDrawerVisibility(STATE.activePage || 'overview');
                break;
            case 'toggle-live-panel-compact':
                event.preventDefault();
                event.stopPropagation();
                setCompactMode(!(STATE.settings.livePanelCompact === true));
                break;
            case 'toggle-live-compact-more':
                event.preventDefault();
                event.stopPropagation();
                setLiveCompactMore(!(STATE.settings.liveCompactMoreOpen === true));
                break;
            case 'toggle-request-payload':
                var payloadView = document.getElementById('requestPayloadView');
                if (payloadView) {
                    var hidden = payloadView.classList.toggle('is-hidden');
                    element.textContent = hidden ? 'Show JSON' : 'Hide JSON';
                }
                break;
            case 'copy-request-payload':
                var selectedReqId = STATE.selectedRequestId;
                var selectedReq = STATE.requestsHistory.find(function(r) {
                    return (r.requestId || (r.timestamp + '-' + (r.keyIndex ?? 0))) === selectedReqId;
                });
                var payloadText = selectedReq && selectedReq.requestPayload && selectedReq.requestPayload.json;
                if (payloadText && window.DashboardFilters && window.DashboardFilters.copyToClipboard) {
                    window.DashboardFilters.copyToClipboard(payloadText, element);
                } else if (window.showToast) {
                    window.showToast('No payload available to copy', 'info');
                }
                break;
            case 'load-request-payload':
                var requestIdToLoad = element.getAttribute('data-request-id') || STATE.selectedRequestId;
                if (!requestIdToLoad) {
                    showToast('Request ID missing for payload load', 'error');
                    break;
                }
                if (element.disabled) break;
                element.disabled = true;
                var originalLabel = element.textContent;
                element.textContent = 'Loading...';
                (async function() {
                    try {
                        var token = sessionStorage.getItem('adminToken') || localStorage.getItem('adminToken');
                        var headers = token ? { 'x-admin-token': token } : {};
                        var response = await fetch('/requests/' + encodeURIComponent(requestIdToLoad) + '/payload', { headers: headers });
                        if (!response.ok) {
                            throw new Error('payload fetch failed: ' + response.status);
                        }
                        var data = await response.json();
                        var payloadData = data && data.payload;
                        if (!payloadData || !payloadData.json) {
                            throw new Error('payload missing in response');
                        }

                        var didUpdate = false;
                        STATE.requestsHistory = STATE.requestsHistory.map(function(r) {
                            var rowId = r.requestId || (r.timestamp + '-' + (r.keyIndex ?? 0));
                            if (rowId !== requestIdToLoad) return r;
                            didUpdate = true;
                            return Object.assign({}, r, {
                                requestPayload: payloadData,
                                requestPayloadAvailable: true,
                                requestPayloadLoaded: true
                            });
                        });

                        if (!didUpdate) {
                            showToast('Request is no longer available in history', 'warning');
                            return;
                        }

                        renderRequestDetails(requestIdToLoad);
                        showToast('Full request payload loaded', 'success');
                    } catch (err) {
                        console.error('Failed to load request payload', err);
                        showToast('Failed to load full payload', 'error');
                    } finally {
                        if (element && element.isConnected) {
                            element.disabled = false;
                            element.textContent = originalLabel;
                        }
                    }
                })();
                break;
            case 'toggle-overflow-menu':
                var dropdown = document.getElementById('overflowMenuDropdown');
                var trigger = document.getElementById('overflowMenuTrigger');
                if (dropdown && trigger) {
                    var isOpen = dropdown.classList.toggle('open');
                    trigger.setAttribute('aria-expanded', String(isOpen));
                }
                if (window.HeaderResponsive && window.HeaderResponsive.refreshLayout) {
                    window.HeaderResponsive.refreshLayout();
                }
                break;
            case 'close-panel':
                closeSidePanel();
                break;
            case 'view-request':
                openSidePanel(element.dataset.requestId);
                break;

            // ---- Misc ----
            case 'toggle-upgrade-info':
                var infoEl = element.nextElementSibling;
                if (infoEl && infoEl.classList.contains('upgrade-info-content')) {
                    infoEl.classList.toggle('visible');
                }
                break;
            case 'reload-page':
                location.reload();
                break;
            case 'dismiss-banner':
                var bannerId = element.dataset.target;
                if (bannerId) {
                    var bannerEl = document.getElementById(bannerId);
                    if (bannerEl) bannerEl.style.display = 'none';
                }
                break;
            case 'scroll-to-account-usage':
                switchPage('overview');
                var acctPanel = document.getElementById('accountUsagePanel');
                if (acctPanel) acctPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
                break;
            case 'enable-routing':
                if (element.disabled) break;
                element.disabled = true;
                element.textContent = 'Enabling...';
                fetch('/model-routing/enable-safe', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ addDefaultRules: true })
                }).then(function(res) {
                    if (res.ok) {
                        element.textContent = 'Enabled!';
                        if (window.showToast) window.showToast('Routing enabled with default rules', 'success');
                        if (window.DashboardTierBuilder && window.DashboardTierBuilder.fetchModelRouting) {
                            window.DashboardTierBuilder.fetchModelRouting();
                        }
                    } else {
                        element.disabled = false;
                        element.textContent = 'Enable Routing';
                        res.json().then(function(err) {
                            if (window.showToast) window.showToast(err.error || 'Failed to enable', 'error');
                        }).catch(function() {
                            if (window.showToast) window.showToast('Failed to enable routing', 'error');
                        });
                    }
                }).catch(function() {
                    element.disabled = false;
                    element.textContent = 'Enable Routing';
                    if (window.showToast) window.showToast('Network error', 'error');
                });
                break;
            case 'toggle-routing':
                var isCurrentlyEnabled = element.textContent.trim() === 'Disable';
                element.disabled = true;
                element.textContent = isCurrentlyEnabled ? 'Disabling...' : 'Enabling...';
                fetch(isCurrentlyEnabled ? '/model-routing' : '/model-routing/enable-safe', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(isCurrentlyEnabled ? { enabled: false } : { addDefaultRules: true })
                }).then(function(res) {
                    element.disabled = false;
                    if (res.ok) {
                        if (window.showToast) window.showToast(isCurrentlyEnabled ? 'Routing disabled' : 'Routing enabled', 'success');
                        if (window.DashboardTierBuilder && window.DashboardTierBuilder.fetchModelRouting) {
                            window.DashboardTierBuilder.fetchModelRouting();
                        }
                    } else {
                        element.textContent = isCurrentlyEnabled ? 'Disable' : 'Enable';
                        if (window.showToast) window.showToast('Failed to toggle routing', 'error');
                    }
                }).catch(function() {
                    element.disabled = false;
                    element.textContent = isCurrentlyEnabled ? 'Disable' : 'Enable';
                    if (window.showToast) window.showToast('Network error', 'error');
                });
                break;
            case 'noop':
                event.preventDefault();
                break;
        }
        });

        // Change event delegation (for select elements like sort dropdown)
        document.addEventListener('change', function(event) {
            var element = event.target.closest('[data-action]');
            if (!element) return;
            var action = element.dataset.action;
            switch (action) {
                case 'sort-models':
                    if (window._tierBuilder) window._tierBuilder.sortBank(element.value);
                    break;
                case 'select-tenant':
                    selectTenant(element.value);
                    break;
                case 'toggle-global-mapping':
                    if (window.DashboardActions && window.DashboardActions.toggleGlobalMapping) {
                        window.DashboardActions.toggleGlobalMapping();
                    }
                    break;
            }
        });
    }

    function bindDrawerResize() {
        if (window.__dashboardDrawerResizeBound) return;
        window.__dashboardDrawerResizeBound = true;

        var handle = document.getElementById('drawerResizeHandle');
        var drawer = document.getElementById('bottomDrawer');
        if (!handle || !drawer) return;

        var dragging = false;

        function onMove(event) {
            if (!dragging) return;
            var pointerY = event.clientY;
            if (!Number.isFinite(pointerY)) return;
            var desired = Math.round(window.innerHeight - pointerY);
            applyDrawerHeight(desired);
        }

        function onUp() {
            if (!dragging) return;
            dragging = false;
            document.body.classList.remove('drawer-resizing');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        }

        handle.addEventListener('mousedown', function(event) {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            dragging = true;
            document.body.classList.add('drawer-resizing');
            setDrawerExpanded(true);
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        handle.addEventListener('dblclick', function(event) {
            event.preventDefault();
            event.stopPropagation();
            applyDrawerHeight(360);
        });

        if (!window.__dashboardDrawerResizeWindowBound) {
            window.__dashboardDrawerResizeWindowBound = true;
            var debouncedApplyDrawerHeight = DS.debounce(function() {
                applyDrawerHeight();
            }, 100);
            window.addEventListener('resize', debouncedApplyDrawerHeight);
        }
    }

    bindDelegatedListeners();
    bindDrawerResize();

    // ========== RELOCATE DOCK PANELS INTO BOTTOM DRAWER ==========
    // Phase 4c promoted dock panel content inline on the Requests page,
    // but the bottom drawer is the correct home for persistent visibility.
    // Move the tab-content back into the drawer; switchDockTab uses global
    // ID selectors so all functionality is preserved.
    (function relocateDockPanels() {
        var drawerContent = document.getElementById('drawerContent');
        var dockContainer = document.getElementById('dockPanelsContainer');
        if (drawerContent && dockContainer) {
            var tabContent = dockContainer.querySelector('.tab-content');
            if (tabContent) {
                drawerContent.appendChild(tabContent);
                dockContainer.remove();
            }
        }
    })();

    (function bootstrapInit() {
        if (window.__dashboardInitBootstrapped) return;
        window.__dashboardInitBootstrapped = true;

        loadTheme();
        loadDensity();
        loadScreenshotModeFromUrl();
        loadTabOrdering();
        initDrawerPreferences();
        loadActiveTab();
        // Migrate legacy localStorage state to hash first
        migrateLegacyState();
        // Then load page from hash (or migrated localStorage)
        loadActivePage();
        initTimeRangeFromUrl();
        initARIA();
        fetchAuthStatus().catch(function() {});
        loadStoredToken();

        // Initialize GlobalSearchManager from filters.js
        if (window.DashboardFilters && window.DashboardFilters.GlobalSearchManager) {
            window.searchManager = new window.DashboardFilters.GlobalSearchManager();
        }

        if (!window.__dashboardKeyboardShortcutsBound) {
            window.__dashboardKeyboardShortcutsBound = true;
            document.addEventListener('keydown', handleKeyboardShortcuts);
        }

        // Initialize vim-style keyboard shortcuts
        if (!window.__dashboardVimShortcutsBound) {
            window.__dashboardVimShortcutsBound = true;
            document.addEventListener('keydown', function(event) {
                // Only handle vim shortcuts when not in an input/textarea
                var activeEl = document.activeElement;
                if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
                    return;
                }
                // Handle single character keys for vim navigation
                if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                    handleVimShortcut(event.key.toLowerCase());
                }
            });
        }
    })();

    // ========== HEADER RESPONSIVE MODULE ==========
    window.HeaderResponsive = (function() {
        var resizeObserver = null;
        var resizeFallbackBound = false;
        var refreshRAF = null;
        var HEADER_BREAKPOINTS = {
            mobileSmall: 480,
            mobileLarge: 768,
            tablet: 1024,
            desktop: 1600
        };

        function init() {
            initResizeObserver();
            bindResizeFallback();
            refreshLayout();
            initSearchToggle();
            initTimeRangeDropdown();
            initOverflowMenu();
            initKeyboardShortcuts();
        }

        function getHeaderWidth() {
            var header = document.querySelector('.sticky-header');
            if (!header) return window.innerWidth || 0;
            return Math.round(header.getBoundingClientRect().width || header.clientWidth || 0);
        }

        function bindResizeFallback() {
            if (resizeFallbackBound) return;
            resizeFallbackBound = true;
            window.addEventListener('resize', refreshLayout);
        }

        function refreshLayout() {
            if (refreshRAF) cancelAnimationFrame(refreshRAF);
            refreshRAF = requestAnimationFrame(function() {
                refreshRAF = null;
                updateHeaderState(getHeaderWidth());
            });
        }

        function initResizeObserver() {
            // Use ResizeObserver for container query fallback
            if (typeof ResizeObserver === 'undefined') return;

            var header = document.querySelector('.sticky-header');
            if (!header) return;

            resizeObserver = new ResizeObserver(function(entries) {
                entries.forEach(function(entry) {
                    var width = entry.contentRect.width;
                    updateHeaderState(width);
                });
            });

            resizeObserver.observe(header);
        }

        function getRootFontSize() {
            var size = parseFloat(window.getComputedStyle(document.documentElement).fontSize || '16');
            return Number.isFinite(size) ? size : 16;
        }

        function isHeaderOverflowing(header) {
            if (!header) return false;
            return header.scrollWidth > (header.clientWidth + 2);
        }

        function applyAdaptiveCompaction(header, width) {
            if (!header) return;

            header.classList.remove('is-cramped', 'is-tight', 'is-ultra-tight');

            // On small/mobile breakpoints, CSS media queries own the layout.
            if (width < HEADER_BREAKPOINTS.tablet) return;

            var scaledUp = getRootFontSize() > 16.5;
            if (scaledUp && width < HEADER_BREAKPOINTS.desktop) {
                header.classList.add('is-cramped');
            }

            if (!header.classList.contains('is-cramped') && !isHeaderOverflowing(header)) {
                return;
            }

            if (!header.classList.contains('is-cramped')) {
                header.classList.add('is-cramped');
            }

            if (isHeaderOverflowing(header)) {
                header.classList.add('is-tight');
            }

            if (isHeaderOverflowing(header)) {
                header.classList.add('is-ultra-tight');
            }
        }

        function updateHeaderState(width) {
            var header = document.querySelector('.sticky-header');
            if (!header) return;

            // Add breakpoint classes for JavaScript hooks
            header.classList.remove('is-mobile-small', 'is-mobile-large', 'is-tablet', 'is-desktop', 'is-ultrawide');

            if (width < HEADER_BREAKPOINTS.mobileSmall) {
                header.classList.add('is-mobile-small');
            } else if (width < HEADER_BREAKPOINTS.mobileLarge) {
                header.classList.add('is-mobile-large');
            } else if (width < HEADER_BREAKPOINTS.tablet) {
                header.classList.add('is-tablet');
            } else if (width < HEADER_BREAKPOINTS.desktop) {
                header.classList.add('is-desktop');
            } else {
                header.classList.add('is-ultrawide');
            }

            applyAdaptiveCompaction(header, width);
        }

        function initSearchToggle() {
            var searchToggle = document.getElementById('searchToggleBtn');
            var searchWrapper = document.getElementById('globalSearchInputWrapper');

            if (!searchToggle || !searchWrapper) return;
            if (searchToggle.dataset.initialized) return;
            searchToggle.dataset.initialized = 'true';

            // Close search when clicking outside
            document.addEventListener('click', function(event) {
                var searchContainer = document.getElementById('globalSearchContainer');
                if (searchContainer && !searchContainer.contains(event.target)) {
                    searchWrapper.classList.remove('open');
                    searchToggle.setAttribute('aria-expanded', 'false');
                }
            });

            // Close search on Escape
            document.addEventListener('keydown', function(event) {
                if (event.key === 'Escape' && searchWrapper.classList.contains('open')) {
                    event.preventDefault();
                    event.stopPropagation();
                    searchWrapper.classList.remove('open');
                    searchToggle.setAttribute('aria-expanded', 'false');
                    searchToggle.focus();
                }
            });
        }

        function initTimeRangeDropdown() {
            var timeToggle = document.getElementById('timeRangeDropdownToggle');
            var timeDropdown = document.getElementById('timeRangeDropdown');

            if (!timeToggle || !timeDropdown) return;
            if (timeToggle.dataset.initialized) return;
            timeToggle.dataset.initialized = 'true';

            // Close dropdown when clicking outside
            document.addEventListener('click', function(event) {
                var timeSelector = document.getElementById('timeRangeSelector');
                if (timeSelector && !timeSelector.contains(event.target)) {
                    timeDropdown.classList.remove('open');
                    timeToggle.setAttribute('aria-expanded', 'false');
                }
            });

            // Close dropdown on Escape
            document.addEventListener('keydown', function(event) {
                if (event.key === 'Escape' && timeDropdown.classList.contains('open')) {
                    event.preventDefault();
                    event.stopPropagation();
                    timeDropdown.classList.remove('open');
                    timeToggle.setAttribute('aria-expanded', 'false');
                    timeToggle.focus();
                }
            });
        }

        function initOverflowMenu() {
            var overflowContainer = document.getElementById('overflowMenuContainer');
            var overflowTrigger = document.getElementById('overflowMenuTrigger');
            var overflowDropdown = document.getElementById('overflowMenuDropdown');

            if (!overflowContainer || !overflowTrigger || !overflowDropdown) return;
            if (overflowTrigger.dataset.initialized) return;
            overflowTrigger.dataset.initialized = 'true';

            // Close overflow when clicking outside (handled in main delegation)
            // Close on Escape
            document.addEventListener('keydown', function(event) {
                if (event.key === 'Escape' && overflowDropdown.classList.contains('open')) {
                    event.preventDefault();
                    event.stopPropagation();
                    overflowDropdown.classList.remove('open');
                    overflowTrigger.setAttribute('aria-expanded', 'false');
                    overflowTrigger.focus();
                }
            });
        }

        function initKeyboardShortcuts() {
            // Ctrl+K / Cmd+K to focus search (existing behavior, but also expand on mobile)
            document.addEventListener('keydown', function(event) {
                if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
                    var searchWrapper = document.getElementById('globalSearchInputWrapper');
                    var searchToggle = document.getElementById('searchToggleBtn');
                    var searchInput = document.getElementById('globalSearchInput');

                    // If search wrapper exists but is hidden (mobile), expand it
                    if (searchWrapper && !searchWrapper.classList.contains('open')) {
                        if (getComputedStyle(searchWrapper).display === 'none' ||
                            searchWrapper.style.display === 'none') {
                            // This is mobile - expand the search
                            event.preventDefault();
                            searchWrapper.classList.add('open');
                            if (searchToggle) searchToggle.setAttribute('aria-expanded', 'true');
                            if (searchInput) searchInput.focus();
                        }
                    }
                }
            });
        }

        function syncAuthOverflowState(authenticated, tokensRequired) {
            var overflowAuthDivider = document.getElementById('overflowAuthDivider');
            var overflowLoginBtn = document.getElementById('overflowLoginBtn');
            var overflowLogoutBtn = document.getElementById('overflowLogoutBtn');

            if (!overflowLoginBtn || !overflowLogoutBtn) return;

            var showLogin = tokensRequired && !authenticated;
            var showLogout = authenticated;

            if (overflowAuthDivider) {
                overflowAuthDivider.style.display = (showLogin || showLogout) ? '' : 'none';
            }

            overflowLoginBtn.style.display = showLogin ? '' : 'none';
            overflowLogoutBtn.style.display = showLogout ? '' : 'none';
            refreshLayout();
        }

        function destroy() {
            if (resizeObserver) {
                resizeObserver.disconnect();
                resizeObserver = null;
            }
            if (resizeFallbackBound) {
                window.removeEventListener('resize', refreshLayout);
                resizeFallbackBound = false;
            }
            if (refreshRAF) {
                cancelAnimationFrame(refreshRAF);
                refreshRAF = null;
            }
        }

        return {
            init: init,
            destroy: destroy,
            syncAuthOverflowState: syncAuthOverflowState,
            updateHeaderState: updateHeaderState,
            refreshLayout: refreshLayout
        };
    })();

    // ========== EXPORT ==========
    window.DashboardInit = {
        toggleTheme: toggleTheme,
        setDensity: setDensity,
        setTimeRange: setTimeRange,
        switchPage: switchPage,
        switchTab: switchTab,
        switchDockTab: switchDockTab,
        switchRequestTab: switchRequestTab,
        switchRoutingTab: switchRoutingTab,
        selectTenant: selectTenant,
        toggleTabOrdering: toggleTabOrdering,
        getTabOrdering: getTabOrdering,
        showShortcutsModal: showShortcutsModal,
        closeShortcutsModal: closeShortcutsModal,
        openSidePanel: openSidePanel,
        closeSidePanel: closeSidePanel,
        showLoginDialog: showLoginDialog,
        logout: logout,
        cleanup: cleanup,
        AUTH_STATE: AUTH_STATE,
        // Hash routing utilities
        initNavigationFromHash: initNavigationFromHash,
        updateHash: updateHash,
        HASH_ROUTES: HASH_ROUTES,
        // Breadcrumb navigation
        updateBreadcrumbs: updateBreadcrumbs
    };

    // Cleanup on page unload (idempotent binding)
    if (!window.__dashboardLifecycleHandlersBound) {
        window.__dashboardLifecycleHandlersBound = true;
        window.addEventListener('beforeunload', cleanup);
        window.addEventListener('pagehide', cleanup);
    }

    // Initialize responsive header after module is defined
    if (window.HeaderResponsive && window.HeaderResponsive.init) {
        window.HeaderResponsive.init();
    }

})(window);
