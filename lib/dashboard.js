'use strict';

/**
 * Dashboard Module
 * Generates the HTML dashboard for the GLM Proxy.
 * CSS and JS are served as external static assets from /dashboard/.
 */

const ASSET_VERSION = require('../package.json').version;

/**
 * Generate inline SVG icon
 * @param {string} name - Icon name
 * @param {number} [size=16] - Icon size in px
 * @param {string} [cls=''] - Additional CSS class
 * @returns {string} SVG HTML string
 */
function svgIcon(name, size = 16, cls = '') {
    const icons = {
        'search': '<path d="M11 17.25a6.25 6.25 0 1 1 0-12.5 6.25 6.25 0 0 1 0 12.5Z"/><path d="m20 20-4.05-4.05"/>',
        'sun': '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
        'moon': '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
        'refresh-cw': '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
        'trash-2': '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
        'key': '<path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
        'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
        'clipboard': '<rect x="9" y="2" width="6" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
        'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        'maximize-2': '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
        'x': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
        'chevron-up': '<polyline points="18 15 12 9 6 15"/>',
        'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
        'settings': '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
        'activity': '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
        'zap': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
        'shield': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
        'info': '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
        'external-link': '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
        'check': '<polyline points="20 6 9 17 4 12"/>',
        'copy': '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        'filter': '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
        'play': '<polygon points="5 3 19 12 5 21 5 3"/>',
        'pause': '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
        'lock': '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        'globe': '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
        // New icons for Diagnostics improvements
        'trending-up': '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
        'trending-down': '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>',
        'minus': '<line x1="5" y1="12" x2="19" y2="12"/>',
        'heart': '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
        'heart-pulse': '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
        'clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        'bar-chart-2': '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
        'award': '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
        'database': '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
        'cpu': '<rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
        'layers': '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
        'alert-circle': '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    };
    const pathData = icons[name] || icons['info'];
    const classAttr = cls ? ` ${cls}` : '';
    return `<svg class="icon${classAttr}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathData}</svg>`;
}


/**
 * Generate dashboard HTML
 * @param {Object} options - Options object
 * @param {string} options.nonce - CSP nonce for inline scripts
 * @param {boolean} options.cspEnabled - Whether CSP is enabled
 */
function generateDashboard(options = {}) {
    const { nonce = '', cspEnabled = false } = options;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GLM Proxy Dashboard</title>
    <script src="/dashboard/vendor/chart.js.min.js"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/vendor/d3.min.js"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/vendor/sortable.min.js"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <link rel="stylesheet" href="/dashboard/css/tokens.css?v=${ASSET_VERSION}">
    <link rel="stylesheet" href="/dashboard/css/layout.css?v=${ASSET_VERSION}">
    <link rel="stylesheet" href="/dashboard/css/components.css?v=${ASSET_VERSION}">
    <link rel="stylesheet" href="/dashboard/css/health.css?v=${ASSET_VERSION}">
    <link rel="stylesheet" href="/dashboard/css/requests.css?v=${ASSET_VERSION}">
    <link rel="stylesheet" href="/dashboard/css/routing.css?v=${ASSET_VERSION}">
    <link rel="stylesheet" href="/dashboard/css/charts.css?v=${ASSET_VERSION}">
    <link rel="stylesheet" href="/dashboard/css/utilities.css?v=${ASSET_VERSION}">
</head>
<body>
    <!-- Skip to Main Content (Accessibility) -->
    <a href="#mainContent" class="skip-to-content">Skip to main content</a>

    <!-- Paused State Banner -->
    <div id="pausedBanner" class="paused-banner" style="display:none;" role="alert" aria-live="polite">
        <span class="paused-banner-icon">${svgIcon('alert-triangle', 20)}</span>
        <span class="paused-banner-text">Proxy is <strong>PAUSED</strong> — all API requests return 503</span>
        <button class="btn btn-small paused-banner-btn" data-action="control-resume">Resume</button>
    </div>

    <!-- Toast Container -->
    <div class="toast-container" id="toastContainer" role="status" aria-live="polite" aria-atomic="true"></div>

    <!-- Screen Reader Announcements -->
    <div class="sr-only" id="screenReaderAnnouncements" role="status" aria-live="polite" aria-atomic="true" style="position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;"></div>

    <!-- Keyboard Shortcuts Modal -->
    <div class="modal-overlay" id="shortcutsModal" data-action="close-modal" data-modal="shortcuts">
        <div class="modal">
            <h2>Keyboard Shortcuts</h2>
            <div class="shortcut-list">
                <div class="shortcut-item">
                    <span>Pause/Resume</span>
                    <span class="shortcut-key"><span class="kbd">P</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Refresh Data</span>
                    <span class="shortcut-key"><span class="kbd">R</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Toggle Dark/Light</span>
                    <span class="shortcut-key"><span class="kbd">T</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Export Data</span>
                    <span class="shortcut-key"><span class="kbd">E</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Fullscreen Chart</span>
                    <span class="shortcut-key"><span class="kbd">F</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Go to Live Stream</span>
                    <span class="shortcut-key"><span class="kbd">L</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Cycle Density</span>
                    <span class="shortcut-key"><span class="kbd">Shift</span>+<span class="kbd">C</span></span>
                </div>
                <div class="divider">
                    <span class="text-sm text-secondary">Requests Page Sub-Tabs</span>
                </div>
                <div class="shortcut-item">
                    <span>Live Stream</span>
                    <span class="shortcut-key"><span class="kbd">1</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Request Traces</span>
                    <span class="shortcut-key"><span class="kbd">2</span></span>
                </div>
                <div class="divider">
                    <span class="text-sm text-secondary">Navigation</span>
                </div>
                <div class="shortcut-item">
                    <span>Navigate Down</span>
                    <span class="shortcut-key"><span class="kbd">j</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Navigate Up</span>
                    <span class="shortcut-key"><span class="kbd">k</span></span>
                </div>
                <div class="shortcut-item">
                    <span>View Details</span>
                    <span class="shortcut-key"><span class="kbd">Enter</span></span>
                </div>
                <div class="divider">
                    <span class="text-sm text-secondary">Quick Filters</span>
                </div>
                <div class="shortcut-item">
                    <span>Status Filter</span>
                    <span class="shortcut-key"><span class="kbd">Ctrl</span>+<span class="kbd">F</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Model Filter</span>
                    <span class="shortcut-key"><span class="kbd">Ctrl</span>+<span class="kbd">M</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Global Search</span>
                    <span class="shortcut-key"><span class="kbd">Ctrl</span>+<span class="kbd">K</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Alt Global Search</span>
                    <span class="shortcut-key"><span class="kbd">Ctrl</span>+<span class="kbd">S</span></span>
                </div>
                <div class="divider"></div>
                <div class="shortcut-item">
                    <span>Show Shortcuts</span>
                    <span class="shortcut-key"><span class="kbd">?</span></span>
                </div>
                <div class="shortcut-item">
                    <span>Close Modal</span>
                    <span class="shortcut-key"><span class="kbd">Esc</span></span>
                </div>
            </div>
        </div>
    </div>

    <!-- Key Override Modal -->
    <div class="modal-overlay" id="keyOverrideModal" data-action="close-modal" data-modal="key-override">
        <div class="modal key-override-modal">
            <div class="modal-header">
                <h2 id="keyOverrideTitle">Configure Routing Overrides</h2>
                <button class="modal-close" data-action="close-key-override-modal">&times;</button>
            </div>
            <div class="modal-body">
                <div class="key-info">
                    <div class="key-info-label">Selected Key</div>
                    <div class="key-info-value" id="keyOverrideKeyName">Key 1</div>
                </div>

                <div class="override-section">
                    <div class="override-section-header">
                        <span class="override-section-title">Routing Overrides</span>
                        <label class="use-global-checkbox">
                            <input type="checkbox" id="useGlobalMapping" checked data-action="toggle-global-mapping">
                            Use global routing
                        </label>
                    </div>
                    <div class="override-list" id="overrideList">
                        <!-- Overrides will be rendered here -->
                    </div>
                    <div class="add-override-form" id="addOverrideForm">
                        <input type="text" id="newClaudeModel" placeholder="Claude model (e.g., claude-sonnet-4-5-20250929)">
                        <input type="text" id="newGlmModel" placeholder="GLM model (e.g., glm-4.7)">
                        <button class="btn btn-primary btn-small" data-action="add-override">Add</button>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" data-action="close-key-override-modal">Cancel</button>
                <button class="btn btn-primary" data-action="save-key-overrides">Save Changes</button>
            </div>
        </div>
    </div>

    <!-- App Container -->
    <div class="app" id="mainContent" tabindex="-1">

    <!-- Header -->
    <header class="sticky-header" data-testid="sticky-header">
        <!-- Section: Branding (always visible) -->
        <div class="header-section header-section--branding">
            <h1 class="header-logo">GLM Proxy</h1>
            <div class="connection-status" id="connectionStatus">
                <span class="connection-dot connected" id="connectionDot" data-testid="connection-dot"></span>
                <span class="connection-text" id="connectionText">Connected</span>
            </div>
            <div class="account-usage-pill unknown" id="headerAccountUsage" data-testid="header-account-usage" title="z.ai usage unavailable" style="cursor: pointer;" data-action="scroll-to-account-usage">
                <span class="account-usage-label">z.ai</span>
                <span class="account-usage-value" id="headerAccountTokenPct">--</span>
                <span class="account-usage-divider">•</span>
                <span class="account-usage-value" id="headerAccountToolPct">--</span>
            </div>
        </div>

        <!-- Section: Primary (search + time range, adapts to size) -->
        <div class="header-section header-section--primary">
            <!-- Collapsible search container -->
            <div class="global-search-container" id="globalSearchContainer">
                <button class="search-toggle-btn" id="searchToggleBtn" data-action="toggle-search" aria-label="Toggle search" aria-expanded="false" title="Search (Ctrl+K)">
                    ${svgIcon('search')}
                </button>
                <div class="global-search-input-wrapper" id="globalSearchInputWrapper">
                    <input type="text" class="global-search-input" id="globalSearchInput" placeholder="Search..." data-testid="global-search" aria-label="Search requests" aria-controls="searchHistoryDropdown">
                    <span class="global-search-shortcut">&#x2318;K</span>
                    <span id="searchingIndicator" class="text-sm text-accent ml-4" aria-live="polite" style="display:none;">Searching…</span>
                    <div class="search-history-dropdown" id="searchHistoryDropdown" role="listbox" aria-label="Search suggestions"></div>
                </div>
            </div>

            <!-- Time range: tabs (desktop) + dropdown (mobile) -->
            <div class="time-range-selector" id="timeRangeSelector" data-testid="time-range">
                <div class="time-range-tabs">
                    <button class="time-range-btn" data-range="5m" data-action="set-time-range">5m</button>
                    <button class="time-range-btn" data-range="15m" data-action="set-time-range">15m</button>
                    <button class="time-range-btn active" data-range="1h" data-action="set-time-range">1h</button>
                    <button class="time-range-btn" data-range="6h" data-action="set-time-range">6h</button>
                    <button class="time-range-btn" data-range="24h" data-action="set-time-range">24h</button>
                    <button class="time-range-btn" data-range="7d" data-action="set-time-range">7d</button>
                </div>
                <button class="time-range-dropdown-toggle" id="timeRangeDropdownToggle" data-action="toggle-time-dropdown" aria-label="Time range" aria-expanded="false" aria-haspopup="listbox">
                    <span id="timeRangeDropdownLabel">1h</span>
                    <span class="dropdown-arrow">&#x25BC;</span>
                </button>
                <div class="time-range-dropdown" id="timeRangeDropdown" role="listbox" aria-label="Select time range">
                    <button class="time-range-dropdown-item active" data-range="5m" data-action="set-time-range" role="option">5 minutes</button>
                    <button class="time-range-dropdown-item" data-range="15m" data-action="set-time-range" role="option">15 minutes</button>
                    <button class="time-range-dropdown-item" data-range="1h" data-action="set-time-range" role="option" aria-selected="true">1 hour</button>
                    <button class="time-range-dropdown-item" data-range="6h" data-action="set-time-range" role="option">6 hours</button>
                    <button class="time-range-dropdown-item" data-range="24h" data-action="set-time-range" role="option">24 hours</button>
                    <button class="time-range-dropdown-item" data-range="7d" data-action="set-time-range" role="option">7 days</button>
                </div>
            </div>
        </div>

        <!-- Section: Actions (pause, issues, toolbar, overflow) -->
        <div class="header-section header-section--actions">
            <button class="btn btn-warning" id="pauseBtn" data-action="control-pause" data-admin="true" data-testid="pause-btn">Pause</button>
            <button class="btn btn-success" id="resumeBtn" data-action="control-resume" data-admin="true" data-testid="resume-btn" style="display:none;">Resume</button>
            <span data-testid="issues-reopen-badge" class="issues-reopen-badge status-badge cursor-pointer" id="issuesReopenBadge"
                  data-action="reopen-issues" style="display:none;" title="Re-open issues panel">
                Issues: <span id="issuesReopenCount">0</span>
            </span>

            <!-- Promoted toolbar (desktop) -->
            <div class="header-toolbar-promoted" id="headerToolbarPromoted">
                <button class="btn-icon-toolbar theme-toggle" data-action="toggle-theme" title="Toggle theme (D)" data-testid="theme-toggle">
                    <span id="themeIcon">${svgIcon('sun')}</span>
                </button>
                <div class="density-toggle-inline" title="Display density" data-testid="density-toggle">
                    <button class="density-btn" data-density="compact" data-action="set-density" title="Compact">&#x25CF;</button>
                    <button class="density-btn active" data-density="comfortable" data-action="set-density" title="Comfortable">&#x25CF;&#x25CF;</button>
                    <button class="density-btn" data-density="spacious" data-action="set-density" title="Spacious">&#x25CF;&#x25CF;&#x25CF;</button>
                </div>
                <button class="btn-icon-toolbar export-btn" data-action="export-data" title="Export data (E)">
                    ${svgIcon('download')}
                </button>
                <button class="btn-icon-toolbar share-url-btn" id="shareUrlBtn" data-action="share-url" title="Copy shareable link">
                    ${svgIcon('external-link')}
                </button>
                <button class="btn-icon-toolbar" data-action="show-shortcuts-modal" title="Keyboard shortcuts (?)">
                    ?
                </button>
                <span id="authBadge" class="auth-badge disabled" data-testid="auth-badge" style="display:none;"></span>
                <button class="btn btn-primary btn-small" id="loginBtn" data-action="show-login" style="display: none;">Login</button>
                <button class="btn btn-secondary btn-small" id="logoutBtn" data-action="logout" style="display: none;">Logout</button>
                <button class="btn btn-secondary btn-small" data-action="reload-keys" data-admin="true">Reload Keys</button>
                <span id="lastRefreshedAt" class="text-xs text-secondary" style="margin-left: 8px; opacity: 0.7;" title="Time since last successful data refresh"></span>
            </div>

            <!-- Overflow menu (mobile) -->
            <div class="overflow-menu-container" id="overflowMenuContainer">
                <button class="overflow-menu-trigger" id="overflowMenuTrigger" data-action="toggle-overflow-menu" aria-label="More options" aria-expanded="false" aria-haspopup="menu">
                    <span class="overflow-dots">&#x22EE;</span>
                </button>
                <div class="overflow-menu-dropdown" id="overflowMenuDropdown" role="menu" aria-label="Additional options">
                    <button class="overflow-menu-item" data-action="toggle-theme" role="menuitem">
                        ${svgIcon('sun')} <span>Toggle Theme</span>
                    </button>
                    <button class="overflow-menu-item" data-action="set-density" data-density="compact" role="menuitem">
                        &#x25CF; Compact
                    </button>
                    <button class="overflow-menu-item" data-action="set-density" data-density="comfortable" role="menuitem">
                        &#x25CF;&#x25CF; Comfortable
                    </button>
                    <button class="overflow-menu-item" data-action="set-density" data-density="spacious" role="menuitem">
                        &#x25CF;&#x25CF;&#x25CF; Spacious
                    </button>
                    <div class="overflow-menu-divider"></div>
                    <button class="overflow-menu-item" data-action="export-data" role="menuitem">
                        ${svgIcon('download')} <span>Export Data</span>
                    </button>
                    <button class="overflow-menu-item" data-action="share-url" role="menuitem">
                        ${svgIcon('external-link')} <span>Copy Share Link</span>
                    </button>
                    <button class="overflow-menu-item" data-action="show-shortcuts-modal" role="menuitem">
                        ? <span>Keyboard Shortcuts</span>
                    </button>
                    <button class="overflow-menu-item" data-action="reload-keys" data-admin="true" role="menuitem">
                        Reload Keys
                    </button>
                    <div class="overflow-menu-divider" id="overflowAuthDivider" style="display:none;"></div>
                    <button class="overflow-menu-item overflow-auth-btn" id="overflowLoginBtn" data-action="show-login" style="display:none;" role="menuitem">
                        Login
                    </button>
                    <button class="overflow-menu-item overflow-auth-btn" id="overflowLogoutBtn" data-action="logout" style="display:none;" role="menuitem">
                        Logout
                    </button>
                </div>
            </div>
        </div>
    </header>

    <!-- Top-Level Page Navigation -->
    <nav class="page-nav" data-testid="page-nav" role="tablist" aria-label="Dashboard pages">
        <button class="page-nav-btn active" data-page="overview" data-action="switch-page" role="tab" aria-selected="true" aria-current="page" tabindex="0">Overview</button>
        <button class="page-nav-btn" data-page="routing" data-action="switch-page" role="tab" aria-selected="false" tabindex="-1">Routing</button>
        <button class="page-nav-btn" data-page="requests" data-action="switch-page" role="tab" aria-selected="false" tabindex="-1">Requests</button>
        <button class="page-nav-btn" data-page="system" data-action="switch-page" role="tab" aria-selected="false" tabindex="-1">Diagnostics</button>
    </nav>

    <!-- Breadcrumb Navigation -->
    <nav class="breadcrumb-nav" id="breadcrumbNav" aria-label="Breadcrumb navigation" data-testid="breadcrumb-nav">
        <!-- Breadcrumbs will be dynamically inserted here -->
    </nav>

    <!-- Global Alert Bar -->
    <div class="alert-bar alert-bar--hidden" id="alertBar" data-testid="alert-bar">
        <div class="alert-item status" id="alertStatusContainer">
            <span class="alert-label">Status</span>
            <span class="alert-value" id="alertStatus">ACTIVE</span>
        </div>
        <div class="alert-item issues" id="alertIssuesContainer">
            <span class="alert-label">Issues</span>
            <span class="alert-value" id="alertIssues">0</span>
        </div>
        <div class="alert-item circuits" id="alertCircuitsContainer">
            <span class="alert-label">Circuits</span>
            <span class="alert-value" id="alertCircuits">0</span>
        </div>
        <div class="alert-item queue" id="alertQueueContainer">
            <span class="alert-label">Queue</span>
            <span class="alert-value" id="alertQueue">0</span>
        </div>
        <div class="alert-item uptime">
            <span class="alert-label">Up</span>
            <span class="alert-value" id="alertUptime">0s</span>
        </div>
    </div>

    <!-- Tenant Selector -->
    <div class="tenant-selector" id="tenantSelectorContainer" style="display: none;">
        <label for="tenantSelect">Tenant:</label>
        <select id="tenantSelect" data-action="select-tenant">
            <option value="">All Tenants</option>
        </select>
        <span id="tenantKeyCount" class="tenant-info"></span>
    </div>

    <!-- Health Ribbon - Unified Status Bar -->
    <section class="health-ribbon" data-testid="health-ribbon">
      <div class="kpi-strip" data-testid="kpi-strip" role="status" aria-live="polite" aria-label="Dashboard metrics">
        <div class="health-item kpi-secondary" data-testid="kpi-status" title="Proxy connection status: ACTIVE (processing requests) or PAUSED (manually paused)">
            <div class="label">Status</div>
            <div class="value">
                <span class="status-indicator">
                    <span class="status-dot active" id="statusDot" data-testid="status-dot"></span>
                    <span id="statusText">ACTIVE</span>
                </span>
            </div>
        </div>
        <div class="health-item kpi-secondary" data-testid="kpi-uptime" title="Time since proxy process started (resets on PM2 restart)">
            <div class="label">Uptime</div>
            <div class="value" id="uptime">0s</div>
        </div>
        <div class="health-item" data-testid="kpi-rpm" title="Client requests per minute (excludes retries)">
            <div class="label">Requests/min</div>
            <div class="value" id="requestsPerMin">0</div>
        </div>
        <div class="health-item" data-testid="kpi-success" title="Percentage of client requests returning 2xx/3xx (excludes internal retries)">
            <div class="label">Success Rate</div>
            <div class="value" id="successRate">100%</div>
        </div>
        <div class="health-item" data-testid="kpi-p95" title="Average response latency across all keys (end-to-end including network)">
            <div class="label">Avg Latency</div>
            <div class="value" id="avgLatency">0ms</div>
        </div>
        <div class="health-item kpi-secondary" data-testid="kpi-health-score" title="Composite 0-100 score based on success rate, latency, error rate, and key health">
            <div class="label">Health Score</div>
            <div class="value with-health-score">
                <span class="health-score-badge excellent" id="healthScoreBadge">100</span>
                <span class="issues-badge none" id="issuesBadge" style="display: none;">0</span>
            </div>
        </div>
        <div class="health-item kpi-secondary" data-testid="kpi-issues" title="Active issues: circuit breaks, high error rate, queue pressure, key exhaustion">
            <div class="label">Issues</div>
            <div class="value">
                <span class="issues-badge none" id="issuesCountBadge">0</span>
            </div>
        </div>
        <div class="health-item" data-testid="kpi-circuits" title="Number of keys with open circuit breakers (temporarily disabled due to errors)" data-action="kpi-navigate" data-page="requests" data-tab="circuit" style="cursor: pointer;">
            <div class="label">Circuits</div>
            <div class="value" id="circuitsRibbonCount">0</div>
            <div class="kpi-subtext" id="circuitsQueueSubtext" title="Current queue depth">Q: <span id="queueInCircuits">0</span></div>
        </div>
        <div class="health-item" data-testid="kpi-queue" title="Requests waiting in backpressure queue when all keys are busy" data-action="kpi-navigate" data-page="requests" data-tab="queue" style="cursor: pointer;">
            <div class="label">Queue</div>
            <div class="value" id="queueRibbonCount">0</div>
        </div>
        <div class="health-item" data-testid="kpi-pool" title="Active concurrent HTTP connections to upstream API">
            <div class="label">Pool</div>
            <div class="value" id="poolStatus">0 active</div>
        </div>
        <div class="health-item" data-testid="kpi-keys" title="API keys available for routing (healthy / total)">
            <div class="label">Keys</div>
            <div class="value" id="activeKeysCount">0</div>
        </div>
      </div>
    </section>

    <!-- Active Issues Panel -->
    <section class="issues-panel page-section" data-belongs-to="overview" id="issuesPanel">
        <div class="issues-header">
            <h3>
                <span>${svgIcon('alert-triangle')}</span> Active Issues
            </h3>
            <button class="btn btn-secondary btn-small" data-action="dismiss-issues">Dismiss</button>
        </div>
        <div class="issues-list" id="issuesList">
            <!-- Issues rendered here -->
        </div>
        <div class="quick-actions" id="quickActions">
            <button class="quick-action-btn" data-action="reset-all-circuits" title="Reset all circuit breakers to CLOSED">
                <span>${svgIcon('refresh-cw')}</span> Reset All Circuits
            </button>
            <button class="quick-action-btn" data-action="clear-queue" title="Clear the request queue">
                <span>${svgIcon('trash-2')}</span> Clear Queue
            </button>
            <button class="quick-action-btn" data-action="reload-keys" title="Reload API keys from configuration">
                <span>${svgIcon('key')}</span> Reload Keys
            </button>
            <button class="quick-action-btn" data-action="export-diagnostics" title="Export diagnostic information">
                <span>${svgIcon('download')}</span> Export Diagnostics
            </button>
        </div>
    </section>

    <!-- Welcome banner (shown when no requests yet) -->
    <div class="welcome-banner page-section" id="welcomeBanner" data-belongs-to="overview" style="display: none;">
        <div class="welcome-content">
            ${svgIcon('activity', 20, 'welcome-icon')}
            <div>
                <strong>Ready to go.</strong> Send requests through the proxy to see real-time metrics.
                <span class="text-secondary">Charts, cost tracking, and model breakdown will populate automatically.</span>
            </div>
        </div>
    </div>

    <!-- Main Content Area -->
    <div class="main-content">
    <!-- Three-Column Dashboard Grid -->
    <div class="dashboard-grid page-section" data-belongs-to="overview">
        <!-- Column 1: Performance -->
        <div class="column-section">
            <div class="column-title">Performance</div>

            <!-- Latency Percentile Cards -->
            <section class="status-cards mb-8 flex-wrap gap-8" id="latencyPercentilesSection">
                <div class="percentile-card">
                    <div class="percentile-label">P50 Latency</div>
                    <div class="percentile-value" id="p50Latency">0</div>
                    <div class="percentile-unit">ms</div>
                </div>
                <div class="percentile-card">
                    <div class="percentile-label">P95 Latency</div>
                    <div class="percentile-value" id="p95Latency">0</div>
                    <div class="percentile-unit">ms</div>
                </div>
                <div class="percentile-card">
                    <div class="percentile-label">P99 Latency</div>
                    <div class="percentile-value" id="p99Latency">0</div>
                    <div class="percentile-unit">ms</div>
                </div>
            </section>

            <!-- Charts (Request Rate, Latency, Error Rate) -->
            <div class="chart-card">
                <h3>Request Rate <span id="chartTimeLabel">(15 min)</span></h3>
                <span id="dataQualityIndicator" class="data-quality-indicator good">Real-time data</span>
                <button class="fullscreen-btn" data-action="toggle-fullscreen" data-chart="requestChartContainer">${svgIcon('maximize-2')}</button>
                <div class="chart-container" id="requestChartContainer">
                    <div class="chart-empty-state" id="requestChartEmpty">Waiting for request data...</div>
                    <canvas id="requestChart"></canvas>
                </div>
            </div>
            <div class="chart-card">
                <h3>Latency <span id="chartTimeLabel2">(15 min)</span></h3>
                <span id="dataQualityIndicator2" class="data-quality-indicator good">Real-time data</span>
                <button class="fullscreen-btn" data-action="toggle-fullscreen" data-chart="latencyChartContainer">${svgIcon('maximize-2')}</button>
                <div class="chart-container" id="latencyChartContainer">
                    <div class="chart-empty-state" id="latencyChartEmpty">Waiting for latency data...</div>
                    <canvas id="latencyChart"></canvas>
                </div>
            </div>
            <div class="chart-card">
                <h3>Error Rate <span id="chartTimeLabel3">(15 min)</span></h3>
                <span id="dataQualityIndicator3" class="data-quality-indicator good">Real-time data</span>
                <button class="fullscreen-btn" data-action="toggle-fullscreen" data-chart="errorChartContainer">${svgIcon('maximize-2')}</button>
                <div class="chart-container" id="errorChartContainer">
                    <div class="chart-empty-state" id="errorChartEmpty">Waiting for error data...</div>
                    <canvas id="errorChart"></canvas>
                </div>
            </div>
        </div>

        <!-- Column 2: Capacity -->
        <div class="column-section">
            <div class="column-title">Capacity</div>

            <!-- Token Usage Panel -->
            <section class="token-panel">
                <h3 class="text-secondary text-sm mb-8 flex justify-between items-center">
                    <span>Token Usage</span>
                    <span class="text-sm text-secondary">Since last reset</span>
                </h3>
                <div class="token-grid">
                    <div class="token-metric">
                        <div class="metric-value" id="totalTokens">0</div>
                        <div class="metric-label">Total Tokens</div>
                    </div>
                    <div class="token-metric">
                        <div class="metric-value" id="inputTokens">0</div>
                        <div class="metric-label">Input Tokens</div>
                    </div>
                    <div class="token-metric">
                        <div class="metric-value" id="outputTokens">0</div>
                        <div class="metric-label">Output Tokens</div>
                    </div>
                    <div class="token-metric">
                        <div class="metric-value" id="avgTokensPerReq">0</div>
                        <div class="metric-label">Avg per Request</div>
                    </div>
                </div>
                <div id="tokenEmptyHint" class="info-hint">
                    Token tracking begins when requests are processed through the proxy
                </div>
            </section>

            <!-- Cost Tracking Panel (#6) -->
            <section class="cost-panel" id="costPanel">
                <h3>
                    <span>Cost Tracking</span>
                    <span class="text-sm text-secondary" id="costPeriodLabel">Today</span>
                </h3>
                <div class="cost-stats">
                    <div class="cost-stat">
                        <div class="label">Today's Cost</div>
                        <div class="value" id="todayCost">$0.00</div>
                    </div>
                    <div class="cost-stat">
                        <div class="label">Projected Daily</div>
                        <div class="value" id="projectedCost">$0.00</div>
                    </div>
                    <div class="cost-stat">
                        <div class="label">This Week</div>
                        <div class="value" id="weekCost">$0.00</div>
                    </div>
                    <div class="cost-stat">
                        <div class="label">This Month</div>
                        <div class="value" id="monthCost">$0.00</div>
                    </div>
                    <div class="cost-stat">
                        <div class="label">Avg per Request</div>
                        <div class="value" id="avgCostPerReq">$0.00</div>
                    </div>
                    <div class="cost-stat">
                        <div class="label">Requests</div>
                        <div class="value" id="costRequests">0</div>
                    </div>
                </div>
                <div id="budgetProgress" style="display: none;">
                    <div class="budget-progress">
                        <div class="budget-fill ok" id="budgetFill" style="width: 0%"></div>
                        <span class="budget-label" id="budgetLabel">0% of budget</span>
                    </div>
                </div>
                <div class="chart-card" id="costChartCard" style="margin-top: 8px; padding: 8px; display: none;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <h4 class="text-sm text-secondary mb-4">Cost Over Time (by Model)</h4>
                        <div class="chart-nav">
                            <button class="btn-sm" data-action="chart-nav" data-chart="costTime" data-dir="left" title="Older">&#x25C0;</button>
                            <button class="btn-sm" data-action="chart-nav" data-chart="costTime" data-dir="reset" title="Latest">&#x23EE;</button>
                            <button class="btn-sm" data-action="chart-nav" data-chart="costTime" data-dir="right" title="Newer">&#x25B6;</button>
                            <span class="text-xs text-secondary" id="costChartRange"></span>
                        </div>
                    </div>
                    <div class="chart-container" style="height: clamp(140px, 14vw, 200px);">
                        <canvas id="costTimeChart"></canvas>
                    </div>
                </div>
                <!-- Per-model cost breakdown table -->
                <div class="table-scroll-wrapper" id="costModelTable" style="margin-top: 8px; display: none;">
                    <table class="model-breakdown-table">
                        <thead>
                            <tr>
                                <th>Model</th>
                                <th>Cost</th>
                                <th>% Share</th>
                                <th>Tokens</th>
                                <th>Requests</th>
                            </tr>
                        </thead>
                        <tbody id="costModelBody">
                        </tbody>
                    </table>
                </div>
                <div id="costEmptyHint" class="info-hint">
                    Cost estimates appear after requests with token usage are processed
                </div>
            </section>

            <!-- z.ai Account Usage Panel -->
            <section class="token-panel" id="accountUsagePanel" style="display: none;" data-testid="account-usage-panel">
                <h3 class="text-secondary text-sm mb-8 flex justify-between items-center">
                    <span>${svgIcon('globe', 14)} Account Usage</span>
                    <span style="display: flex; align-items: center; gap: 6px;">
                        <span class="text-sm text-secondary" id="accountUsageLevel"></span>
                        <button class="btn-details-toggle" id="acctDetailsBtn" data-action="toggle-account-details" title="Show account details">Details &#x25B8;</button>
                    </span>
                </h3>
                <div class="token-grid">
                    <div class="token-metric">
                        <div class="metric-value" id="acctTokenPercent">-</div>
                        <div class="metric-label">Token Quota Used</div>
                    </div>
                    <div class="token-metric">
                        <div class="metric-value" id="acctToolUsed">-</div>
                        <div class="metric-label">Tool Calls Used</div>
                    </div>
                    <div class="token-metric">
                        <div class="metric-value" id="acctToolRemaining">-</div>
                        <div class="metric-label">Tool Calls Left</div>
                    </div>
                    <div class="token-metric">
                        <div class="metric-value" id="acctRequests24h">-</div>
                        <div class="metric-label">Requests (24h)</div>
                    </div>
                </div>
                <div class="budget-progress" id="acctTokenProgress" style="margin-top: 8px;">
                    <div class="budget-fill ok" id="acctTokenFill" style="width: 0%"></div>
                    <span class="budget-label" id="acctTokenLabel">0% token quota</span>
                </div>
                <div class="text-xs text-secondary" style="margin-top: 4px;" id="acctResetTime"></div>
                <div class="account-usage-status text-xs text-secondary" id="acctUsageStatus" style="display: none;"></div>
                <div id="acctDetailsSection" style="display: none;" class="account-details-section">
                    <!-- Server Status by Tier -->
                    <div style="margin-bottom: 10px;">
                        <div class="text-xs text-secondary font-semibold" style="margin-bottom: 6px;">Server Status</div>
                        <div id="acctTierStatus" class="tier-status-grid"></div>
                    </div>
                    <!-- Quota Limits Breakdown -->
                    <div style="margin-bottom: 10px;">
                        <div class="text-xs text-secondary font-semibold" style="margin-bottom: 6px;">Quota Limits</div>
                        <div id="acctDetailLimits" class="text-xs text-secondary"></div>
                    </div>
                    <!-- API Keys Health -->
                    <div style="margin-bottom: 10px;">
                        <div class="text-xs text-secondary font-semibold" style="margin-bottom: 6px;">API Keys</div>
                        <div id="acctKeyHealth" class="text-xs text-secondary"></div>
                    </div>
                    <!-- Tool Usage Breakdown -->
                    <div id="acctDetailToolBreakdown" class="text-xs text-secondary"></div>
                </div>
                <div class="chart-card" style="margin-top: 12px; padding: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <h4 class="text-sm text-secondary mb-4">Token Usage Over Time</h4>
                        <div class="chart-nav">
                            <button class="btn-sm" data-action="chart-nav" data-chart="acctToken" data-dir="left" title="Older">&#x25C0;</button>
                            <button class="btn-sm" data-action="chart-nav" data-chart="acctToken" data-dir="reset" title="Latest">&#x23EE;</button>
                            <button class="btn-sm" data-action="chart-nav" data-chart="acctToken" data-dir="right" title="Newer">&#x25B6;</button>
                            <span class="text-xs text-secondary" id="acctTokenChartRange"></span>
                        </div>
                    </div>
                    <div class="chart-container" style="height: clamp(120px, 12vw, 160px);">
                        <canvas id="acctTokenChart"></canvas>
                    </div>
                </div>
                <div class="chart-card" style="margin-top: 8px; padding: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <h4 class="text-sm text-secondary mb-4">Requests Over Time</h4>
                        <div class="chart-nav">
                            <button class="btn-sm" data-action="chart-nav" data-chart="acctRequest" data-dir="left" title="Older">&#x25C0;</button>
                            <button class="btn-sm" data-action="chart-nav" data-chart="acctRequest" data-dir="reset" title="Latest">&#x23EE;</button>
                            <button class="btn-sm" data-action="chart-nav" data-chart="acctRequest" data-dir="right" title="Newer">&#x25B6;</button>
                            <span class="text-xs text-secondary" id="acctRequestChartRange"></span>
                        </div>
                    </div>
                    <div class="chart-container" style="height: clamp(120px, 12vw, 160px);">
                        <canvas id="acctRequestChart"></canvas>
                    </div>
                </div>
            </section>

            <!-- Per-Model Breakdown -->
            <section class="model-breakdown-section" id="modelBreakdownSection">
                <h3 class="text-secondary text-sm mb-8 flex justify-between items-center">
                    <span>Per-Model Breakdown</span>
                    <span class="text-xs text-secondary" id="modelBreakdownCount"></span>
                </h3>
                <div class="chart-card" style="padding: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <h4 class="text-sm text-secondary mb-4">Tokens by Model</h4>
                    </div>
                    <div class="chart-container" style="height: clamp(140px, 14vw, 200px);">
                        <canvas id="modelTokenChart"></canvas>
                    </div>
                </div>
                <div class="table-scroll-wrapper" style="margin-top: 8px;">
                    <table class="model-breakdown-table">
                        <thead>
                            <tr>
                                <th>Model</th>
                                <th>Requests</th>
                                <th>Input Tokens</th>
                                <th>Output Tokens</th>
                                <th>Success %</th>
                                <th>Avg Latency</th>
                                <th>P95</th>
                                <th>429 Rate</th>
                            </tr>
                        </thead>
                        <tbody id="modelBreakdownBody">
                            <tr><td colspan="8" class="text-secondary">No model data yet</td></tr>
                        </tbody>
                    </table>
                </div>
                <div id="modelBreakdownHint" class="info-hint">
                    Per-model breakdown appears after requests across multiple models
                </div>
            </section>

            <!-- Request Distribution Chart (compact) -->
            <div class="chart-card" id="distChartCard">
                <h3>Request Distribution</h3>
                <button class="fullscreen-btn" data-action="toggle-fullscreen" data-chart="distChartContainer">${svgIcon('maximize-2')}</button>
                <div class="chart-container" id="distChartContainer" style="height: clamp(100px, 10vw, 140px);">
                    <div class="chart-empty-state" id="distChartEmpty">Waiting for distribution data...</div>
                    <canvas id="distChart"></canvas>
                </div>
            </div>

            <!-- Live Request Stream moved to Tab 1 (Tabbed Details) -->
        </div>

        <!-- Column 3: Key Health -->
        <div class="column-section">
            <div class="column-title">Key Health</div>

            <!-- API Keys Heatmap -->
            <section class="keys-section">
                <h3>API Keys <span class="text-xs font-normal text-secondary ml-8">Click key for details</span></h3>
                <div class="keys-heatmap" id="keysHeatmap" data-testid="keys-heatmap"></div>
            </section>

            <!-- Key Details Panel -->
            <section class="key-details" id="keyDetails">
                <div class="key-details-header">
                    <h3 id="keyDetailsTitle">Key Details</h3>
                    <div class="flex gap-8">
                        <button class="btn btn-secondary btn-small configure-overrides-btn" data-action="open-key-override-modal">Configure Overrides</button>
                        <button class="btn btn-secondary btn-small" data-action="close-key-details">Close</button>
                    </div>
                </div>
                <div class="key-details-grid">
                    <div class="key-detail-item">
                        <div class="label">Circuit State</div>
                        <div class="value" id="detailCircuitState">-</div>
                    </div>
                    <div class="key-detail-item">
                        <div class="label">Total Requests</div>
                        <div class="value" id="detailTotalRequests">0</div>
                    </div>
                    <div class="key-detail-item">
                        <div class="label">Success Rate</div>
                        <div class="value" id="detailSuccessRate">-</div>
                    </div>
                    <div class="key-detail-item">
                        <div class="label">Avg Latency</div>
                        <div class="value" id="detailLatency">-</div>
                    </div>
                    <div class="key-detail-item">
                        <div class="label">In-Flight Requests</div>
                        <div class="value" id="detailActiveRequests">0</div>
                    </div>
                    <div class="key-detail-item">
                        <div class="label">Failures</div>
                        <div class="value" id="detailFailures">0</div>
                    </div>
                </div>
                <div class="section-divider-block">
                    <div class="section-header">
                        <span class="text-sm text-secondary">Health Score:</span>
                        <span id="detailHealthScore" class="font-semibold">100/100</span>
                        <span id="detailSlowKeyBadge" class="slow-badge" style="display: none;">SLOW</span>
                    </div>
                    <div class="key-details-grid">
                        <div class="key-detail-item">
                            <div class="label">Latency Score</div>
                            <div class="value" id="detailHealthLatency">40/40</div>
                        </div>
                        <div class="key-detail-item">
                            <div class="label">Success Score</div>
                            <div class="value" id="detailHealthSuccess">40/40</div>
                        </div>
                        <div class="key-detail-item">
                            <div class="label">Recency Score</div>
                            <div class="value" id="detailHealthRecency">20/20</div>
                        </div>
                    </div>
                </div>
                <div class="section-divider-block">
                    <div class="section-header">
                        <span class="text-sm text-secondary">Rate Limit Tracking:</span>
                        <span id="detailRateLimitStatus" class="font-semibold">OK</span>
                    </div>
                    <div class="key-details-grid">
                        <div class="key-detail-item">
                            <div class="label">429 Count</div>
                            <div class="value" id="detailRateLimit429s">0</div>
                        </div>
                        <div class="key-detail-item">
                            <div class="label">Last 429</div>
                            <div class="value" id="detailRateLimitLastHit">-</div>
                        </div>
                        <div class="key-detail-item">
                            <div class="label">Cooldown</div>
                            <div class="value" id="detailRateLimitCooldown">-</div>
                        </div>
                    </div>
                </div>
                <div class="circuit-controls">
                    <span class="text-secondary text-sm mr-8">Force State:</span>
                    <button class="btn btn-success btn-small" data-action="force-circuit-state" data-state="CLOSED">CLOSED</button>
                    <button class="btn btn-warning btn-small" data-action="force-circuit-state" data-state="HALF_OPEN">HALF_OPEN</button>
                    <button class="btn btn-danger btn-small" data-action="force-circuit-state" data-state="OPEN">OPEN</button>
                </div>
            </section>

            <!-- Model Mapping Panel — merged into Models Section below -->
        </div>
    </div>
    <!-- End Three-Column Grid -->

    <!-- Unified Model Selection Section -->
    <section class="model-selection-section page-section" id="modelSelectionSection" data-testid="model-selection-section"
             data-belongs-to="routing" role="region" aria-label="Model Selection">
        <div class="model-selection-header section-header flex-wrap px-4">
            <h2 class="m-0" style="font-size: 1.1rem;">Model Selection</h2>
            <span class="routing-status-pill" id="routingStatusPill">Routing: Off</span>
        </div>
        <div class="active-system-status text-sm text-secondary mb-12 px-4" id="activeSystemStatus">Active system: None</div>

    <!-- Model Routing Panel (top-level: badges, stats, tier builder) -->
    <section class="model-routing-panel" id="modelRoutingPanel" data-testid="model-routing-panel">
        <h3>
            <span class="routing-section-toggle open" data-toggle="routingContent">Model Routing</span><span class="section-subtitle">Smart routing + failover</span>
            <div class="routing-status">
                <span class="status-badge disabled" id="routingStatusBadge">Disabled</span>
                <button class="btn btn-small routing-toggle-btn" id="routingToggleBtn" data-action="toggle-routing" title="Toggle routing on/off">Enable</button>
                <span class="persist-badge badge-warning" id="routing-persist-badge" title="Changes will be lost on restart">Runtime Only</span>
                <a href="#" data-action="noop" title="See docs/model-routing.md in the repository" class="ml-auto text-sm text-accent">Learn more</a>
            </div>
        </h3>
        <div class="routing-collapsible open" id="routingContent">
            <div id="routing-persist-warning" class="persist-warning" style="display:none;">
                <strong>Warning:</strong> Config persistence is disabled. Changes made here will be lost on restart.
                Enable <code>persistConfigEdits: true</code> in your config to persist changes.
            </div>
            <!-- Stats Row -->
            <div class="routing-stats-grid" id="routingStatsGrid">
                <div class="routing-stat-item">
                    <div class="label">Total</div>
                    <div class="value" id="routingTotal">0</div>
                </div>
                <div class="routing-stat-item">
                    <div class="label">Light</div>
                    <div class="value" id="routingLight">0</div>
                </div>
                <div class="routing-stat-item">
                    <div class="label">Medium</div>
                    <div class="value" id="routingMedium">0</div>
                </div>
                <div class="routing-stat-item">
                    <div class="label">Heavy</div>
                    <div class="value" id="routingHeavy">0</div>
                </div>
                <div class="routing-stat-item">
                    <div class="label">Failovers</div>
                    <div class="value" id="routingFailovers">0</div>
                </div>
                <div class="routing-stat-item">
                    <div class="label">Pool</div>
                    <div class="value" id="routingPools">0</div>
                </div>
                <div class="routing-stat-item" title="Heavy requests eligible for GLM-5 preference (cumulative)">
                    <div class="label">GLM-5 Eligible</div>
                    <div class="value" id="routingGlm5Eligible">0</div>
                </div>
                <div class="routing-stat-item" title="Requests where GLM-5 preference was applied (cumulative)">
                    <div class="label">GLM-5 Applied</div>
                    <div class="value" id="routingGlm5Applied">0</div>
                </div>
                <div class="routing-stat-item" title="Genuine context overflow: request exceeds all available models (400)">
                    <div class="label">Overflow</div>
                    <div class="value" id="routingOverflowGenuine">0</div>
                </div>
                <div class="routing-stat-item" title="Transient context overflow: 200K models temporarily unavailable (503 if retries enabled)">
                    <div class="label">Overflow (T)</div>
                    <div class="value" id="routingOverflowTransient">0</div>
                </div>
            </div>

            <!-- Routing Disabled CTA (shown when routing is off) -->
            <div id="routingDisabledCTA" class="routing-disabled-cta">
                <div class="routing-disabled-content">
                    <div class="routing-disabled-icon">${svgIcon('layers', 32, 'routing-disabled-hero-icon')}</div>
                    <h4 class="routing-disabled-title">Smart Routing is Off</h4>
                    <p class="routing-disabled-desc">
                        Route requests to optimal models based on complexity.
                        Automatic failover, tier-based load balancing, and cooldown management.
                    </p>
                    <button class="btn btn-primary" id="enableRoutingBtn" data-action="enable-routing">Enable Routing</button>
                    <p class="routing-disabled-hint">Or set <code>modelRouting.enabled: true</code> in your config</p>
                </div>
            </div>

            <!-- Tier Builder (shown when routing is on) -->
            <div id="routingEnabledContent">
            <h4 class="routing-subsection-title mt-8">
                Tiers <span class="config-badge config-badge-live" title="Drag models between tiers, then Save">Live</span>
            </h4>
            <div id="tierBuilderContainer" class="tier-builder" data-belongs-to="routing">
                <!-- Available Models Bank -->
                <div class="models-bank">
                    <div class="models-bank-header">
                        <span class="models-bank-title">Available Models</span>
                        <span class="models-bank-count" id="modelsBankCount">0</span>
                        <select class="filter-select models-bank-sort" id="modelsBankSort"
                                data-action="sort-models" aria-label="Sort available models">
                            <option value="name">Name</option>
                            <option value="tier">Tier</option>
                            <option value="price-asc">Price &#x2191;</option>
                            <option value="price-desc">Price &#x2193;</option>
                            <option value="concurrency">Concurrency</option>
                        </select>
                    </div>
                    <div class="models-bank-list" id="modelsBankList">
                        <div class="tier-builder-empty">Loading models...</div>
                    </div>
                </div>

                <!-- Tier Lanes -->
                <div class="tier-lanes">
                    <div class="tier-lane" data-tier="heavy">
                        <div class="tier-lane-header">
                            <span class="tier-lane-name">Opus (Heavy)</span>
                            <select class="tier-lane-strategy" id="tierStrategyHeavy" title="Pool strategy for heavy tier">
                                <option value="quality">Quality</option>
                                <option value="throughput">Throughput</option>
                                <option value="balanced">Balanced</option>
                            </select>
                        </div>
                        <div class="tier-lane-models" id="tierLaneHeavy">
                            <div class="tier-lane-empty">Drop models here</div>
                        </div>
                    </div>
                    <div class="tier-lane" data-tier="medium">
                        <div class="tier-lane-header">
                            <span class="tier-lane-name">Sonnet (Medium)</span>
                            <select class="tier-lane-strategy" id="tierStrategyMedium" title="Pool strategy for medium tier">
                                <option value="quality">Quality</option>
                                <option value="throughput">Throughput</option>
                                <option value="balanced" selected>Balanced</option>
                            </select>
                        </div>
                        <div class="tier-lane-models" id="tierLaneMedium">
                            <div class="tier-lane-empty">Drop models here</div>
                        </div>
                    </div>
                    <div class="tier-lane" data-tier="light">
                        <div class="tier-lane-header">
                            <span class="tier-lane-name">Haiku (Light)</span>
                            <select class="tier-lane-strategy" id="tierStrategyLight" title="Pool strategy for light tier">
                                <option value="quality">Quality</option>
                                <option value="throughput">Throughput</option>
                                <option value="balanced">Balanced</option>
                            </select>
                        </div>
                        <div class="tier-lane-models" id="tierLaneLight">
                            <div class="tier-lane-empty">Drop models here</div>
                        </div>
                    </div>
                </div>

                <!-- Pending Changes Bar -->
                <div class="tier-builder-actions">
                    <span class="pending-badge" id="tierBuilderPending" title="Unsaved changes" style="display: none;">
                        <span class="pending-badge-count" id="tierBuilderPendingCount">0</span> pending
                    </span>
                    <button class="btn btn-secondary btn-small" id="tierBuilderReset" disabled title="Revert to server state">Reset</button>
                    <button class="btn btn-primary btn-small" id="tierBuilderSave" disabled title="Save tier configuration">Save</button>
                </div>
            </div>
            </div> <!-- /routingEnabledContent -->
        </div>
    </section>

    <!-- Live Flow Visualization (D3.js) -->
    <div id="liveFlowContainer" class="live-flow-container page-section" data-belongs-to="routing"
         role="img" aria-label="Live request routing flow visualization">
        <div class="live-flow-header">
            <h4>Request Flow</h4>
            <span class="live-flow-status" id="liveFlowStatus">Connecting...</span>
        </div>
        <div class="live-flow-canvas" id="liveFlowCanvas">
            <!-- D3.js will render the swim-lane SVG here -->
            <div class="live-flow-empty state-empty" id="liveFlowEmpty">
                <span class="state-icon">⋯</span>
                <span class="state-message">Model routing not enabled</span>
            </div>
        </div>
        <div class="live-flow-legend" id="liveFlowLegend">
            <span><span class="legend-dot legend-heavy"></span>Heavy</span>
            <span><span class="legend-dot legend-medium"></span>Medium</span>
            <span><span class="legend-dot legend-light"></span>Light</span>
        </div>
    </div>

    <!-- Routing Tabs (Observability, Cooldowns, Overrides, Advanced) — hidden when routing disabled -->
    <div class="routing-tabs page-section" id="routingTabsSection" data-belongs-to="routing" style="display: none;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <h4 class="text-sm text-secondary m-0" style="cursor: pointer;" data-action="toggle-routing-tabs">Advanced Panels <span id="routingTabsToggle">&#x25B8;</span></h4>
        </div>
        <div id="routingTabsCollapsible" style="display: none;">
        <div class="routing-tab-nav" role="tablist" aria-label="Routing panels">
            <button class="routing-tab-btn active" data-routing-tab="observability"
                    data-action="switch-routing-tab"
                    id="routingTab-observability" role="tab" aria-selected="true" aria-controls="routingPanel-observability" tabindex="0">Observability</button>
            <button class="routing-tab-btn" data-routing-tab="cooldowns"
                    data-action="switch-routing-tab"
                    id="routingTab-cooldowns" role="tab" aria-selected="false" aria-controls="routingPanel-cooldowns" tabindex="-1">Cooldowns</button>
            <button class="routing-tab-btn" data-routing-tab="overrides"
                    data-action="switch-routing-tab"
                    id="routingTab-overrides" role="tab" aria-selected="false" aria-controls="routingPanel-overrides" tabindex="-1">Overrides</button>
            <button class="routing-tab-btn" data-routing-tab="advanced"
                    data-action="switch-routing-tab"
                    id="routingTab-advanced" role="tab" aria-selected="false" aria-controls="routingPanel-advanced" tabindex="-1">Advanced</button>
        </div>
        <div class="routing-tab-content">
            <!-- Observability Tab -->
            <div class="routing-tab-panel active" data-routing-panel="observability"
                 id="routingPanel-observability" role="tabpanel" aria-labelledby="routingTab-observability">
                <div class="routing-obs-panel" id="routingObsPanel">
                    <h4>Routing Observability</h4>

                    <div id="routingObsStatus" class="routing-obs-status routing-obs-status-bar"></div>

                    <!-- KPIs: window-relative rates computed from history deltas -->
                    <div class="routing-obs-kpis">
                        <div class="routing-obs-kpi" title="No routing decisions recorded yet">
                            <div class="label">Burst Share</div>
                            <div class="value" id="routingBurstShare">0%</div>
                        </div>
                        <div class="routing-obs-kpi" title="No routing decisions recorded yet">
                            <div class="label">Failover Share</div>
                            <div class="value" id="routingFailoverShare">0%</div>
                        </div>
                        <div class="routing-obs-kpi">
                            <div class="label">429/min</div>
                            <div class="value" id="routing429PerMin">0</div>
                        </div>
                        <div class="routing-obs-kpi" title="No pool cooldown data">
                            <div class="label">Pool Cooldown</div>
                            <div class="value" id="routingPoolCooldown">N/A</div>
                        </div>
                        <div class="routing-obs-kpi">
                            <div class="label">Decisions</div>
                            <div class="value" id="routingDecisionsInWindow">0</div>
                        </div>
                    </div>

                    <!-- Distribution charts -->
                    <div class="routing-obs-chart-row">
                        <div class="routing-obs-chart-container">
                            <div class="routing-obs-chart-title">Decisions by Tier</div>
                            <canvas id="routingTierChart" height="120"></canvas>
                        </div>
                        <div class="routing-obs-chart-container">
                            <div class="routing-obs-chart-title">Decisions by Source</div>
                            <canvas id="routingSourceChart" height="120"></canvas>
                        </div>
                    </div>

                    <!-- Time-series: 429 rate + burst dampening -->
                    <div class="routing-obs-chart-container">
                        <div class="routing-obs-chart-title">
                            429s &amp; Burst Dampening
                            <div class="routing-obs-time-selector" id="routingTimeSelector">
                                <button class="time-range-btn active" data-range="5m" data-action="set-routing-time">5m</button>
                                <button class="time-range-btn" data-range="1h" data-action="set-routing-time">1h</button>
                                <button class="time-range-btn" data-range="24h" data-action="set-routing-time">24h</button>
                            </div>
                        </div>
                        <canvas id="routing429Chart" height="140"></canvas>
                    </div>

                    <!-- Actions -->
                    <button class="btn btn-small btn-secondary" data-action="copy-routing-snapshot">Copy Snapshot JSON</button>
                </div>
            </div>

            <!-- Cooldowns Tab -->
            <div class="routing-tab-panel" data-routing-panel="cooldowns"
                 id="routingPanel-cooldowns" role="tabpanel" aria-labelledby="routingTab-cooldowns">
                <!-- Fallback Chain Visualization -->
                <h4 class="routing-subsection-title">Fallback Chains</h4>
                <div class="fallback-chains" id="fallbackChainsViz">
                    <div class="text-secondary text-sm">Loading...</div>
                </div>

                <!-- Model Pool Status -->
                <div id="modelPoolsSection" style="display: none;">
                    <h4 class="routing-subsection-title--spaced">Model Pools</h4>
                    <div id="modelPoolsViz" class="model-pools">
                        <div class="text-secondary text-sm">Loading...</div>
                    </div>
                </div>

                <!-- Active Cooldowns -->
                <h4 class="routing-subsection-title--spaced">Active Cooldowns</h4>
                <div class="table-scroll-wrapper">
                <table class="routing-cooldown-table">
                    <thead>
                        <tr>
                            <th>Model</th>
                            <th>Remaining</th>
                            <th>Count</th>
                        </tr>
                    </thead>
                    <tbody id="routingCooldownBody">
                        <tr><td colspan="3" class="text-secondary">None</td></tr>
                    </tbody>
                </table>
                </div>
            </div>

            <!-- Overrides Tab -->
            <div class="routing-tab-panel" data-routing-panel="overrides"
                 id="routingPanel-overrides" role="tabpanel" aria-labelledby="routingTab-overrides">
                <!-- Saved Overrides -->
                <h4 class="routing-subsection-title">Saved Overrides <span class="config-badge config-badge-live" title="Override changes apply immediately">Live</span></h4>
                <div class="table-scroll-wrapper">
                <table class="routing-override-table">
                    <thead>
                        <tr>
                            <th>Key</th>
                            <th>Model</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="routingOverrideBody">
                        <tr><td colspan="3" class="text-secondary">None</td></tr>
                    </tbody>
                </table>
                </div>
                <div class="flex gap-8 mt-8">
                    <input type="text" id="routingOverrideKey" placeholder="Model key or *" class="override-input">
                    <input type="text" id="routingOverrideModel" placeholder="Target model" class="override-input">
                    <button class="btn btn-primary btn-small" data-action="add-routing-override">Add</button>
                </div>

                <!-- Routing Rules Builder -->
                <h4 class="routing-subsection-title--spaced">
                    Routing Rules <span class="config-badge config-badge-live" title="Rule changes apply via API">Live</span>
                </h4>
                <div class="table-scroll-wrapper">
                <table class="routing-rules-table">
                    <thead>
                        <tr>
                            <th>Model Pattern</th>
                            <th>Conditions</th>
                            <th>Target Tier</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="routingRulesBody">
                        <tr><td colspan="4" class="text-secondary">No rules configured</td></tr>
                    </tbody>
                </table>
                </div>
                <div class="rule-builder-form rule-builder-row">
                    <div class="flex-1 min-w-120">
                        <label class="form-label-xs">Model Glob</label>
                        <input type="text" id="ruleModelGlob" placeholder="e.g. claude-3-haiku-*" class="inline-input-base">
                    </div>
                    <div class="min-w-80">
                        <label class="form-label-xs">Max Tokens &ge;</label>
                        <input type="number" id="ruleMaxTokens" placeholder="--" class="narrow-input-80">
                    </div>
                    <div class="min-w-80">
                        <label class="form-label-xs">Messages &ge;</label>
                        <input type="number" id="ruleMessages" placeholder="--" class="narrow-input-80">
                    </div>
                    <div class="flex-row gap-8">
                        <label class="form-label-xs--plain"><input type="checkbox" id="ruleHasTools"> Tools</label>
                        <label class="form-label-xs--plain"><input type="checkbox" id="ruleHasVision"> Vision</label>
                    </div>
                    <div class="min-w-90">
                        <label class="form-label-xs">Tier</label>
                        <select id="ruleTier" class="inline-input-base">
                            <option value="light">Light</option>
                            <option value="medium">Medium</option>
                            <option value="heavy">Heavy</option>
                        </select>
                    </div>
                    <button class="btn btn-primary btn-small" data-action="add-routing-rule">Add Rule</button>
                </div>
            </div>

            <!-- Advanced Tab -->
            <div class="routing-tab-panel" data-routing-panel="advanced"
                 id="routingPanel-advanced" role="tabpanel" aria-labelledby="routingTab-advanced">
                <!-- Test Tool -->
                <h4 class="routing-subsection-title">Test Classifier <span class="config-badge config-badge-live" title="Dry-run, no side effects">Live</span></h4>
                <div class="routing-test-form">
                    <div>
                        <label>Model</label>
                        <input type="text" id="routingTestModel" placeholder="Enter model to test..." class="w-full">
                    </div>
                    <div>
                        <label>Max Tokens (blank=unset)</label>
                        <input type="text" id="routingTestMaxTokens" placeholder="e.g. 4096" class="w-full">
                    </div>
                    <div>
                        <label>Messages</label>
                        <input type="number" id="routingTestMessages" value="1" min="0" class="w-full">
                    </div>
                    <div>
                        <label>System Length</label>
                        <input type="number" id="routingTestSystemLength" value="0" min="0" class="w-full">
                    </div>
                    <div>
                        <label><input type="checkbox" id="routingTestTools"> Tools</label>
                    </div>
                    <div>
                        <label><input type="checkbox" id="routingTestVision"> Vision</label>
                    </div>
                    <div class="grid-col-full">
                        <button class="btn btn-secondary btn-small" data-action="run-routing-test">Test</button>
                        <button class="btn btn-secondary btn-small ml-8" data-action="reset-model-routing">Reset All</button>
                        <button class="btn btn-secondary btn-small ml-8" data-action="copy-routing-json">Copy JSON</button>
                        <button class="btn btn-secondary btn-small ml-8" data-action="export-routing-json">Export</button>
                    </div>
                    <div class="routing-test-result" id="routingTestResult"></div>
                </div>

                <!-- Explain Routing Decision -->
                <div class="routing-explain-section">
                    <h4>Explain Routing Decision</h4>
                    <p class="section-description">Dry-run a routing decision without affecting state. Uses the same model/parameters from Test Classifier above.</p>
                    <button class="btn btn-secondary" data-action="run-explain" id="explainBtn">
                        Explain Decision
                    </button>
                    <div id="explainResult" class="explain-result-container" style="display:none;"></div>
                </div>

                <!-- Per-Model Usage -->
                <h4 class="routing-subsection-title--spaced">Per-Model Usage</h4>
                <div class="table-scroll-wrapper">
                <table class="routing-model-usage-table">
                    <thead>
                        <tr>
                            <th>Model</th>
                            <th>Requests</th>
                            <th>Success</th>
                            <th>429s</th>
                            <th>Avg Latency</th>
                            <th>Tokens (In/Out)</th>
                        </tr>
                    </thead>
                    <tbody id="modelUsageBody">
                        <tr><td colspan="6" class="text-secondary">No data yet</td></tr>
                    </tbody>
                </table>
                </div>
            </div>
        </div>
        </div><!-- end routingTabsCollapsible -->
    </div>
    </section><!-- End model-selection-section -->

    <!-- Error & Queue Info -->
    <section class="info-row page-section" data-belongs-to="system">
        <div class="info-card" id="errorBreakdownCard">
            <h3>
                <span class="icon-wrapper">${svgIcon('alert-triangle', 16, 'info-card-icon')}</span>
                Error Breakdown
                <button class="btn btn-secondary btn-small" data-action="kpi-navigate" data-page="requests" data-tab="traces" style="font-size: var(--font-xs);">View Traces</button>
                <button class="btn btn-secondary btn-small" data-action="reset-stats">Reset Stats</button>
            </h3>
            <div class="info-grid">
                <div class="info-item with-status" data-severity="warning" title="Request exceeded configured timeout waiting for upstream response">
                    <div class="label">Timeouts</div>
                    <div class="value" id="errorTimeouts">0</div>
                </div>
                <div class="info-item with-status" data-severity="warning" title="Upstream closed the connection unexpectedly mid-stream">
                    <div class="label">Hangups</div>
                    <div class="value" id="errorHangups">0</div>
                </div>
                <div class="info-item with-status" data-severity="error" title="5xx responses from the upstream API (internal server errors)">
                    <div class="label">Server Errors</div>
                    <div class="value" id="errorServer">0</div>
                </div>
                <div class="info-item with-status" data-severity="warning" title="429 responses — upstream API rate limit exceeded for this key">
                    <div class="label">Rate Limited</div>
                    <div class="value" id="errorRateLimited">0</div>
                </div>
                <div class="info-item with-status" data-severity="error" title="Connection refused (ECONNREFUSED) — upstream server unavailable">
                    <div class="label">Overloaded</div>
                    <div class="value" id="errorOverloaded">0</div>
                </div>
                <div class="info-item with-status" data-severity="error" title="401/403 responses — invalid or expired API key">
                    <div class="label">Auth Errors</div>
                    <div class="value" id="errorAuth">0</div>
                </div>
                <div class="info-item with-status status-good" title="Percentage of retried requests that eventually succeeded">
                    <div class="label">Retry Success</div>
                    <div class="value" id="errorRetrySuccessRate">-</div>
                </div>
            </div>
            <details class="mt-8" style="font-size: var(--font-xs);">
                <summary class="text-secondary" style="cursor: pointer;">Extended Error Categories</summary>
                <div class="info-grid mt-8">
                    <div class="info-item" title="DNS resolution failures (ENOTFOUND)">
                        <div class="label">DNS Errors</div>
                        <div class="value" id="errorDns">0</div>
                    </div>
                    <div class="info-item" title="TLS/SSL handshake failures">
                        <div class="label">TLS Errors</div>
                        <div class="value" id="errorTls">0</div>
                    </div>
                    <div class="info-item" title="Write failed on already-closed connection (EPIPE)">
                        <div class="label">Broken Pipe</div>
                        <div class="value" id="errorBrokenPipe">0</div>
                    </div>
                    <div class="info-item" title="SSE stream terminated by upstream before completion">
                        <div class="label">Stream Close</div>
                        <div class="value" id="errorStreamClose">0</div>
                    </div>
                    <div class="info-item" title="Malformed HTTP response from upstream (HPE_*)">
                        <div class="label">HTTP Parse</div>
                        <div class="value" id="errorHttpParse">0</div>
                    </div>
                    <div class="info-item" title="Client closed the connection before response completed">
                        <div class="label">Client Disconnect</div>
                        <div class="value" id="errorClientDisconnect">0</div>
                    </div>
                    <div class="info-item" title="529 response — model temporarily at capacity, try later">
                        <div class="label">Model at Capacity</div>
                        <div class="value" id="errorModelCapacity">0</div>
                    </div>
                    <div class="info-item" title="Exhausted all retry attempts without a successful response">
                        <div class="label">Give-ups</div>
                        <div class="value" id="errorGiveUps">0</div>
                    </div>
                </div>
            </details>
        </div>

        <div class="info-card" id="retryAnalyticsCard">
            <h3>
                <span class="icon-wrapper">${svgIcon('trending-up', 16, 'info-card-icon')}</span>
                Retry Analytics
            </h3>
            <div class="info-grid">
                <div class="info-item">
                    <div class="label">Total Retries</div>
                    <div class="value" id="retryTotal">0</div>
                </div>
                <div class="info-item with-status status-good">
                    <div class="label">Retries Succeeded</div>
                    <div class="value" id="retrySucceeded">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Success Rate</div>
                    <div class="value" id="retryRate">-</div>
                </div>
                <div class="info-item">
                    <div class="label">Same-Model Retries</div>
                    <div class="value" id="retrySameModel">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Avg Backoff</div>
                    <div class="value" id="retryAvgBackoff">-</div>
                </div>
            </div>
            <details class="mt-8" style="font-size: var(--font-xs);">
                <summary class="text-secondary" style="cursor: pointer;">Model Switch Details</summary>
                <div class="info-grid mt-8">
                    <div class="info-item">
                        <div class="label">Model Switches on Failure</div>
                        <div class="value" id="retryModelSwitches">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Models Tried on Failure</div>
                        <div class="value" id="retryModelsTried">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Failed w/ Model Stats</div>
                        <div class="value" id="retryFailedWithStats">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Give-ups</div>
                        <div class="value" id="retryGiveUps">0</div>
                    </div>
                </div>
            </details>
            <details class="mt-8" style="font-size: var(--font-xs);">
                <summary class="text-secondary" style="cursor: pointer;">Give-up Reasons</summary>
                <div class="info-grid mt-8">
                    <div class="info-item">
                        <div class="label">Max 429 Attempts</div>
                        <div class="value" id="giveupMax429Attempts">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Max 429 Window</div>
                        <div class="value" id="giveupMax429Window">0</div>
                    </div>
                </div>
            </details>
            <details class="mt-8" style="font-size: var(--font-xs);">
                <summary class="text-secondary" style="cursor: pointer;">Telemetry</summary>
                <div class="info-grid mt-8">
                    <div class="info-item">
                        <div class="label">Dropped</div>
                        <div class="value" id="telemetryDropped">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Passed Through</div>
                        <div class="value" id="telemetryPassed">0</div>
                    </div>
                </div>
            </details>
        </div>

        <div class="info-card">
            <h3>
                <span class="icon-wrapper">${svgIcon('layers', 16, 'info-card-icon')}</span>
                Queue & Backpressure
            </h3>
            <div class="info-grid">
                <div class="info-item">
                    <div class="label">Queue Size</div>
                    <div class="value" id="queueSize">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Max Queue</div>
                    <div class="value" id="queueMax">100</div>
                </div>
                <div class="info-item">
                    <div class="label">Active HTTP Requests</div>
                    <div class="value" id="connections">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Max Concurrent</div>
                    <div class="value" id="connectionsMax">100</div>
                </div>
            </div>
            <div class="queue-progress">
                <div class="progress-bar">
                    <div class="progress-fill" id="queueProgress" style="width: 0%"></div>
                </div>
                <div class="progress-label" id="queuePercent">
                    <span class="current-value">0/100</span>
                    <span>0%</span>
                </div>
            </div>
            <details class="mt-8" style="font-size: var(--font-xs);">
                <summary class="text-secondary" style="cursor: pointer;">Admission Hold</summary>
                <div class="info-grid mt-8">
                    <div class="info-item">
                        <div class="label">Total Holds</div>
                        <div class="value" id="admHoldTotal">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Succeeded</div>
                        <div class="value" id="admHoldSucceeded">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Timed Out</div>
                        <div class="value" id="admHoldTimedOut">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Rejected</div>
                        <div class="value" id="admHoldRejected">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Light Tier</div>
                        <div class="value" id="admHoldLight">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Medium Tier</div>
                        <div class="value" id="admHoldMedium">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Heavy Tier</div>
                        <div class="value" id="admHoldHeavy">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Avg Hold Time</div>
                        <div class="value" id="admHoldAvgMs">-</div>
                    </div>
                </div>
            </details>
        </div>

        <div class="info-card">
            <h3>
                <span class="icon-wrapper">${svgIcon('shield', 16, 'info-card-icon')}</span>
                Rate Limit Status
            </h3>
            <div class="info-grid">
                <div class="info-item">
                    <div class="label">Keys Available</div>
                    <div class="value" id="rlKeysAvailable">-</div>
                </div>
                <div class="info-item">
                    <div class="label">Keys in Cooldown</div>
                    <div class="value" id="rlKeysInCooldown">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Total 429s</div>
                    <div class="value" id="rlTotal429s">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Upstream 429s</div>
                    <div class="value" id="rlUpstream429s">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Local 429s</div>
                    <div class="value" id="rlLocal429s">0</div>
                </div>
            </div>
            <div id="rlCooldownList" class="mt-8 text-sm text-secondary"></div>
        </div>

        <div class="info-card">
            <h3>
                Request Semantics
                <span class="text-xs font-normal text-secondary ml-8">
                    ${svgIcon('info')} Client requests vs key attempts
                </span>
            </h3>
            <div class="info-grid">
                <div class="info-item">
                    <div class="label">Client Requests</div>
                    <div class="value" id="clientRequests">0</div>
                    <div class="info-note">Unique requests from clients</div>
                </div>
                <div class="info-item">
                    <div class="label">Client Success Rate</div>
                    <div class="value" id="clientSuccessRate">100%</div>
                    <div class="info-note">True user success rate</div>
                </div>
                <div class="info-item">
                    <div class="label">Key Attempts</div>
                    <div class="value" id="keyAttempts">0</div>
                    <div class="info-note">Includes retries</div>
                </div>
                <div class="info-item">
                    <div class="label">In-Flight Requests</div>
                    <div class="value" id="inFlightRequests">0</div>
                    <div class="info-note">Currently processing</div>
                </div>
            </div>
        </div>
    </section>

    <!-- Connection Health & Adaptive Timeouts -->
    <section class="info-row page-section" data-belongs-to="system">
        <div class="info-card">
            <h3>
                <span class="icon-wrapper">${svgIcon('activity', 16, 'info-card-icon')}</span>
                Connection Health
            </h3>
            <div class="info-grid">
                <div class="info-item" title="Proxy process uptime since last PM2 restart">
                    <div class="label">Uptime</div>
                    <div class="value" id="systemUptime">0s</div>
                </div>
                <div class="info-item" title="Total socket hangups from upstream (connection closed unexpectedly)">
                    <div class="label">Total Hangups</div>
                    <div class="value" id="healthTotalHangups">0</div>
                </div>
                <div class="info-item" title="Consecutive hangups without a successful request (triggers agent recreation at threshold)">
                    <div class="label">Consecutive</div>
                    <div class="value" id="healthConsecutive">0</div>
                </div>
                <div class="info-item" title="HTTP agent pool recreations triggered by consecutive hangup threshold">
                    <div class="label">Agent Recreations</div>
                    <div class="value" id="healthAgentRecreations">0</div>
                </div>
                <div class="info-item" title="Average round-trip latency across all active HTTP connections in the pool">
                    <div class="label">Pool Avg Latency</div>
                    <div class="value" id="healthPoolAvgLatency">0ms</div>
                </div>
            </div>
            <details class="mt-8" style="font-size: var(--font-xs);">
                <summary class="text-secondary" style="cursor: pointer;">Adaptive Timeouts</summary>
                <div class="info-grid mt-8">
                    <div class="info-item" title="Current average adaptive timeout (adjusts based on recent response times)">
                        <div class="label">Avg Timeout</div>
                        <div class="value" id="atAvgTimeout">-</div>
                    </div>
                    <div class="info-item" title="Minimum timeout floor (never goes below this value)">
                        <div class="label">Min Timeout</div>
                        <div class="value" id="atMinTimeout">-</div>
                    </div>
                    <div class="info-item" title="Maximum timeout ceiling (never exceeds this value)">
                        <div class="label">Max Timeout</div>
                        <div class="value" id="atMaxTimeout">-</div>
                    </div>
                    <div class="info-item" title="Number of requests using adaptive (dynamic) timeouts vs static">
                        <div class="label">Adaptive Used</div>
                        <div class="value" id="atUsedCount">0</div>
                    </div>
                </div>
            </details>
            <details class="mt-8" style="font-size: var(--font-xs);">
                <summary class="text-secondary" style="cursor: pointer;">Hangup Causes</summary>
                <div class="info-grid mt-8">
                    <div class="info-item" title="Hangup from reusing an idle socket that the server had already closed">
                        <div class="label">Stale Socket Reuse</div>
                        <div class="value" id="hangupStale">0</div>
                    </div>
                    <div class="info-item" title="Client disconnected before the proxy could finish relaying the response">
                        <div class="label">Client Abort</div>
                        <div class="value" id="hangupClientAbort">0</div>
                    </div>
                    <div class="info-item" title="Hangup on a fresh (newly created) socket — indicates upstream instability">
                        <div class="label">Fresh Socket</div>
                        <div class="value" id="hangupFresh">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Unknown</div>
                        <div class="value" id="hangupUnknown">0</div>
                    </div>
                </div>
            </details>
        </div>

        <div class="info-card" id="healthScoreCard">
            <h3>
                <span class="icon-wrapper">${svgIcon('heart-pulse', 16, 'info-card-icon')}</span>
                Health Score Distribution
                <span class="heartbeat-indicator healthy" id="heartbeatIndicator">
                    <span class="heartbeat-pulse"></span>
                    <span id="heartbeatStatus">Healthy</span>
                </span>
            </h3>
            <div class="health-radial" id="healthRadial">
                <svg viewBox="0 0 36 36">
                    <circle class="radial-bg" cx="18" cy="18" r="15.915"/>
                    <circle class="radial-fill excellent" id="healthRadialFill" cx="18" cy="18" r="15.915"
                        stroke-dasharray="100, 100" stroke-dashoffset="25"/>
                </svg>
                <div class="radial-value" id="healthRadialValue">--<span class="score-max"></span></div>
                <div class="radial-label">Avg Score</div>
            </div>
            <div class="score-distribution">
                <div class="score-segment excellent" id="scoreExcellent" style="width: 25%"></div>
                <div class="score-segment good" id="scoreGood" style="width: 25%"></div>
                <div class="score-segment fair" id="scoreFair" style="width: 25%"></div>
                <div class="score-segment poor" id="scorePoor" style="width: 25%"></div>
            </div>
            <div class="info-grid mt-8">
                <div class="info-item">
                    <div class="label">Excellent (80+)</div>
                    <div class="value" id="scoreExcellentCount">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Good (60-79)</div>
                    <div class="value" id="scoreGoodCount">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Fair (40-59)</div>
                    <div class="value" id="scoreFairCount">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Poor (0-39)</div>
                    <div class="value" id="scorePoorCount">0</div>
                </div>
            </div>
            <div class="info-grid mt-8">
                <div class="info-item">
                    <div class="label">Slow Key Events</div>
                    <div class="value" id="slowKeyEvents">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Slow Key Recoveries</div>
                    <div class="value" id="slowKeyRecoveries">0</div>
                </div>
            </div>
        </div>
    </section>

    <!-- Latency Histogram & Key Comparison -->
    <section class="info-row page-section" data-belongs-to="system">
        <div class="info-card">
            <h3>
                <span class="icon-wrapper">${svgIcon('bar-chart-2', 16, 'info-card-icon')}</span>
                Latency Distribution
            </h3>
            <div class="info-grid">
                <div class="info-item">
                    <div class="label">Count</div>
                    <div class="value" id="histogramCount">0</div>
                </div>
                <div class="info-item">
                    <div class="label">Avg</div>
                    <div class="value" id="histogramAvg">0ms</div>
                </div>
                <div class="info-item">
                    <div class="label">P50</div>
                    <div class="value" id="histogramP50">0ms</div>
                </div>
                <div class="info-item">
                    <div class="label">P95</div>
                    <div class="value" id="histogramP95">0ms</div>
                </div>
                <div class="info-item">
                    <div class="label">P99</div>
                    <div class="value" id="histogramP99">0ms</div>
                </div>
            </div>
            <div class="chart-container" style="height: clamp(140px, 14vw, 200px); margin-top: 8px;">
                <canvas id="histogramChart"></canvas>
            </div>
        </div>

        <div class="info-card">
            <h3>
                <span class="icon-wrapper">${svgIcon('award', 16, 'info-card-icon')}</span>
                Key Comparison
            </h3>
            <div id="comparisonGrid" class="comparison-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px;"></div>
            <div id="insightsList" class="insights-list" style="margin-top: 8px;"></div>
            <div class="info-hint" id="comparisonEmptyHint">Key comparison data appears after sufficient request history</div>
        </div>
    </section>

    <!-- Lifetime Stats, AIMD Concurrency & Predictions (Collapsible) -->
    <section class="info-row page-section" data-belongs-to="system">
        <div class="collapsible-section collapsed" id="advancedStatsSection">
            <div class="collapsible-header" role="button" tabindex="0" aria-expanded="false" aria-controls="advancedStatsContent">
                <div class="collapsible-header-title">
                    <span class="icon-wrapper">${svgIcon('clock', 16)}</span>
                    <span>Advanced Statistics</span>
                    <span class="text-xs text-secondary ml-8">Lifetime, AIMD, Predictions</span>
                </div>
                <svg class="collapsible-chevron" viewBox="0 0 20 20">
                    <path d="M10 14l-5-5h10l-5 5z"/>
                </svg>
            </div>
            <div class="collapsible-content" id="advancedStatsContent">
                <div class="info-card" id="persistentStatsCard">
                    <h3>
                        <span class="icon-wrapper">${svgIcon('clock', 16, 'info-card-icon')}</span>
                        Lifetime Statistics
                    </h3>
                    <div class="info-grid">
                        <div class="info-item">
                            <div class="label">Tracking Since</div>
                            <div class="value text-sm" id="psTrackingSince">-</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Total Requests</div>
                            <div class="value" id="psTotalRequests">0</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Successes</div>
                            <div class="value" id="psTotalSuccesses">0</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Failures</div>
                            <div class="value" id="psTotalFailures">0</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Retries</div>
                            <div class="value" id="psTotalRetries">0</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Keys Used</div>
                            <div class="value" id="psKeysUsed">-</div>
                        </div>
                    </div>
                    <div id="psUnusedWarning" class="info-hint" style="display: none; color: var(--warning);"></div>
                </div>

                <div class="info-card" id="aimdCard">
                    <h3>
                        <span>Adaptive Concurrency (AIMD)</span>
                        <span class="badge badge-info text-xs" id="aimdMode">-</span>
                    </h3>
                    <div id="aimdModelsList"></div>
                    <div class="info-hint" id="aimdEmptyHint">AIMD data appears when adaptive concurrency is enabled</div>
                </div>

                <div class="info-card" id="predictionsCard">
                    <h3>Predictions & Anomalies</h3>
                    <div class="info-grid">
                        <div class="info-item">
                            <div class="label">Critical Keys</div>
                            <div class="value" id="predCriticalKeys">0</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Trend</div>
                            <div class="value" id="predTrend">stable</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Anomalies</div>
                            <div class="value" id="predAnomalies">0</div>
                        </div>
                    </div>
                    <div id="predRecommendations" class="mt-8 text-xs text-secondary"></div>
                    <div class="info-hint" id="predEmptyHint">Predictions appear after sufficient request history</div>
                </div>
            </div>
        </div>
    </section>

    <!-- Process Health & Scheduler (Collapsible) -->
    <section class="info-row page-section" data-belongs-to="system">
        <div class="collapsible-section collapsed" id="processHealthSection">
            <div class="collapsible-header" role="button" tabindex="0" aria-expanded="false" aria-controls="processHealthContent">
                <div class="collapsible-header-title">
                    <span class="icon-wrapper">${svgIcon('cpu', 16)}</span>
                    <span>Process & Scheduler</span>
                    <span class="text-xs text-secondary ml-8">Heap, Memory, Fairness</span>
                </div>
                <svg class="collapsible-chevron" viewBox="0 0 20 20">
                    <path d="M10 14l-5-5h10l-5 5z"/>
                </svg>
            </div>
            <div class="collapsible-content" id="processHealthContent">
                <div class="info-card" id="processHealthCard">
                    <h3>
                        <span class="icon-wrapper">${svgIcon('cpu', 16, 'info-card-icon')}</span>
                        Process Health
                        <span class="badge badge-info text-xs" id="processHealthStatus">-</span>
                    </h3>
                    <div class="info-grid">
                        <div class="info-item">
                            <div class="label">Heap Used</div>
                            <div class="value" id="phHeapUsed">-</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Heap Total</div>
                            <div class="value" id="phHeapTotal">-</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Memory %</div>
                            <div class="value" id="phMemPercent">-</div>
                        </div>
                        <div class="info-item">
                            <div class="label">RSS</div>
                            <div class="value" id="phRss">-</div>
                        </div>
                    </div>
                    <details class="mt-8" style="font-size: var(--font-xs);">
                        <summary class="text-secondary" style="cursor: pointer;">Process Info</summary>
                        <div class="info-grid mt-8">
                            <div class="info-item">
                                <div class="label">PID</div>
                                <div class="value" id="phPid">-</div>
                            </div>
                            <div class="info-item">
                                <div class="label">Node Version</div>
                                <div class="value" id="phNodeVersion">-</div>
                            </div>
                            <div class="info-item">
                                <div class="label">Traces Stored</div>
                                <div class="value" id="phTracesStored">-</div>
                            </div>
                            <div class="info-item">
                                <div class="label">Trace Capacity</div>
                                <div class="value" id="phTraceCapacity">-</div>
                            </div>
                        </div>
                    </details>
                </div>

                <div class="info-card" id="schedulerCard">
                    <h3>
                        <span class="icon-wrapper">${svgIcon('layers', 16, 'info-card-icon')}</span>
                        Scheduler
                        <span class="badge badge-info text-xs" id="schedulerPoolState">-</span>
                    </h3>
                    <div class="info-grid">
                        <div class="info-item">
                            <div class="label">Fairness Score</div>
                            <div class="value" id="schedFairness">-</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Avg Latency</div>
                            <div class="value" id="schedAvgLatency">-</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Weighted %</div>
                            <div class="value" id="schedWeighted">-</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Round Robin %</div>
                            <div class="value" id="schedRoundRobin">-</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <!-- Requests Page: Sub-Tab Navigation (Phase 4c) -->
    <div class="page-section" data-belongs-to="requests">
        <div class="sub-tabs" id="requestsSubTabs">
            <button class="sub-tab active" data-action="switch-request-tab" data-tab="table">Table</button>
            <button class="sub-tab" data-action="switch-request-tab" data-tab="live">Live Stream</button>
            <button class="sub-tab" data-action="switch-request-tab" data-tab="traces">Traces</button>
        </div>
    </div>

    <!-- Requests Page: Summary Cards -->
    <div class="page-section request-tab-content" data-belongs-to="requests" data-tab="table">
        <div class="request-summary-cards grid-auto-fit-cards">
            <div class="info-card">
                <div class="info-item">
                    <div class="label">Total Requests</div>
                    <div class="value" id="reqPageTotal">0</div>
                </div>
            </div>
            <div class="info-card">
                <div class="info-item">
                    <div class="label">Success Rate</div>
                    <div class="value" id="reqPageSuccessRate">0%</div>
                </div>
            </div>
            <div class="info-card">
                <div class="info-item">
                    <div class="label">Avg Latency</div>
                    <div class="value" id="reqPageAvgLatency">0ms</div>
                </div>
            </div>
            <div class="info-card">
                <div class="info-item">
                    <div class="label">Error Count</div>
                    <div class="value" id="reqPageErrors">0</div>
                </div>
            </div>
            <div class="info-card">
                <div class="info-item">
                    <div class="label">In Flight</div>
                    <div class="value" id="reqPageInFlight">0</div>
                </div>
            </div>
        </div>
    </div>

    <!-- Requests Page: Recent Requests Table -->
    <div class="page-section request-tab-content" data-belongs-to="requests" data-tab="table">
        <div class="info-card p-12">
            <h3 class="m-0 mb-8" style="font-size: 0.9rem;">Recent Requests</h3>
            <div id="recentRequestsTable" class="overflow-x-auto">
                <table class="request-table">
                    <thead>
                        <tr class="request-table-header">
                            <th class="text-left p-6-8">Time</th>
                            <th class="text-left p-6-8">Key</th>
                            <th class="text-left p-6-8">Model</th>
                            <th class="text-left p-6-8">Status</th>
                            <th class="text-right p-6-8">Latency</th>
                        </tr>
                    </thead>
                    <tbody id="recentRequestsBody">
                        <tr><td colspan="5" class="text-center p-32-8 text-secondary">
                            No requests yet. Send API requests through the proxy to see them here.<br>
                            <span class="text-sm opacity-70">Tip: Switch to the Live Stream tab (press L) for real-time request monitoring</span>
                        </td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <!-- Dock panels removed from here (M5) — now rendered directly inside #drawerContent below -->
    </div><!-- End .main-content -->

    <!-- Bottom Drawer (Milestone B) + Dock Tabs (Phase 3) -->
    <div class="bottom-drawer" id="bottomDrawer" data-testid="bottom-drawer">
        <div class="drawer-header" data-action="toggle-drawer">
            <span class="drawer-title" data-testid="drawer-title">Live Stream</span>
            <span class="request-count-badge" data-testid="request-count-badge" id="requestCountBadge">0</span>
            <div class="dock-tabs flex ml-8" style="gap:2px;" role="tablist" aria-label="Dock panels">
                <button class="dock-tab dock-tab-base active" data-dock-tab="live" data-testid="tab-live" data-action="switch-dock-tab" role="tab" aria-selected="true" tabindex="0">Live <span class="tab-shortcut">1</span></button>
                <button class="dock-tab dock-tab-base" data-dock-tab="traces" data-testid="tab-traces" data-action="switch-dock-tab" role="tab" aria-selected="false" tabindex="-1">Traces <span class="tab-shortcut">2</span></button>
                <button class="dock-tab dock-tab-base" data-dock-tab="logs" data-testid="tab-logs" data-action="switch-dock-tab" role="tab" aria-selected="false" tabindex="-1">Logs <span class="tab-shortcut">3</span></button>
                <button class="dock-tab dock-tab-base" data-dock-tab="queue" data-testid="tab-queue" data-action="switch-dock-tab" role="tab" aria-selected="false" tabindex="-1">Queue <span class="tab-shortcut">4</span></button>
                <button class="dock-tab dock-tab-base" data-dock-tab="circuit" data-testid="tab-circuit" data-action="switch-dock-tab" role="tab" aria-selected="false" tabindex="-1">Circuit <span class="tab-shortcut">5</span></button>
            </div>
            <button class="drawer-compact-toggle" id="drawerCompactToggle" data-action="toggle-live-panel-compact" data-testid="drawer-compact-toggle" title="Toggle compact controls">Compact</button>
            <button class="drawer-scope-toggle" id="drawerScopeToggle" data-action="toggle-live-panel-scope" data-testid="drawer-scope-toggle" title="Toggle visibility on all pages">All Pages</button>
            <button class="drawer-toggle ml-auto" data-testid="drawer-toggle" aria-expanded="false" aria-controls="drawerContent">&#9650;</button>
        </div>
        <div class="drawer-resize-handle" id="drawerResizeHandle" data-testid="drawer-resize-handle" title="Drag to resize panel"></div>
        <div class="drawer-content" id="drawerContent">
        <div class="tab-content">
            <div class="tab-panel active" id="tab-live">
                <!-- Filter Toolbar -->
                <div class="stream-toolbar" data-testid="stream-toolbar">
                    <div class="filter-group">
                        <button class="ordering-indicator ordering-newest-top" data-action="toggle-ordering" data-tab="live" title="Click to reverse ordering" aria-pressed="true">Newest at top ↓</button>
                        <select id="filterStatus" class="filter-select" data-action="filter-change" title="Filter by status">
                            <option value="">All Status</option>
                            <option value="success">Success</option>
                            <option value="error">Error</option>
                            <option value="pending">Pending</option>
                        </select>
                        <select id="filterKey" class="filter-select" data-action="filter-change" title="Filter by key">
                            <option value="">All Keys</option>
                        </select>
                        <select id="filterModel" class="filter-select" data-action="filter-change" title="Filter by model">
                            <option value="">All Models</option>
                        </select>
                        <button class="btn btn-secondary btn-small" data-action="clear-filters" title="Clear all filters">Clear</button>
                    </div>
                    <div class="stream-controls">
                        <button class="btn btn-secondary btn-small compact-more-toggle" id="compactMoreToggle" data-action="toggle-live-compact-more" title="Show hidden live controls">
                            More
                        </button>
                        <button class="btn btn-icon" id="autoScrollToggle" data-action="toggle-autoscroll" title="Toggle auto-scroll (on)">
                            <span class="autoscroll-icon">${svgIcon('chevron-down')}</span>
                        </button>
                        <button class="btn btn-icon" data-action="jump-to-latest" title="Jump to latest">
                            <span>${svgIcon('chevron-down')}</span>
                        </button>
                    </div>
                </div>
                <div class="virtual-scroll-viewport flex-1-1-auto overflow-y-auto min-h-200 max-h-60vh" data-testid="virtual-viewport" tabindex="0">
                    <div class="virtual-scroll-content request-list" id="liveStreamRequestList" data-testid="virtual-content" role="region" aria-live="polite" aria-atomic="false" aria-label="Request stream updates">
                        <div class="text-center text-secondary p-20">
                            Connecting to request stream...
                        </div>
                    </div>
                </div>
                <div class="stream-footer">
                    <span class="filter-count" id="filterCount">Showing all requests</span>
                    <span class="stream-summary" id="liveStreamSummary">No requests yet</span>
                    <span class="keyboard-hint">Press <kbd>j</kbd>/<kbd>k</kbd> to navigate, <kbd>Enter</kbd> to view details</span>
                </div>
            </div>

            <!-- Tab 2: Request Traces (Week 2 - Enhanced, Week 7 - Drill-down & Filters) -->
            <div class="tab-panel" id="tab-traces">
                <!-- Enhanced Filter Toolbar (Week 7) -->
                <div class="stream-toolbar mb-8">
                    <div class="filter-group flex-wrap gap-6">
                        <button class="ordering-indicator ordering-newest-top" data-action="toggle-ordering" data-tab="traces" title="Click to reverse ordering" aria-pressed="true">Newest at top ↓</button>
                        <select id="traceFilterStatus" class="filter-select" data-action="trace-filter-change" title="Filter by status">
                            <option value="">All Status</option>
                            <option value="true">Success</option>
                            <option value="false">Failed</option>
                        </select>
                        <select id="traceFilterRetries" class="filter-select" data-action="trace-filter-change" title="Filter by retries">
                            <option value="">All Traces</option>
                            <option value="true">With Retries</option>
                        </select>
                        <select id="traceFilterTimeRange" class="filter-select" data-action="trace-filter-change" title="Time range">
                            <option value="">All Time</option>
                            <option value="5">Last 5 min</option>
                            <option value="15">Last 15 min</option>
                            <option value="60">Last 1 hour</option>
                            <option value="360">Last 6 hours</option>
                        </select>
                        <select id="traceFilterLatency" class="filter-select" data-action="trace-filter-change" title="Latency threshold">
                            <option value="">Any Latency</option>
                            <option value="1000">Slow (>1s)</option>
                            <option value="5000">Very Slow (>5s)</option>
                            <option value="10000">Critical (>10s)</option>
                        </select>
                        <input type="text" id="traceFilterPath" class="filter-input filter-input-120"
                               placeholder="Filter path..."
                               data-action="trace-filter-change" title="Filter by path (partial match)">
                        <input type="text" id="traceSearchId" class="filter-input filter-input-140"
                               placeholder="Search trace ID..."
                               data-action="trace-search" title="Search by trace ID">
                    </div>
                    <div class="flex items-center gap-6">
                        <button class="btn btn-secondary btn-small" data-action="load-traces" title="Refresh traces">Refresh</button>
                        <button class="btn btn-secondary btn-small" data-action="export-traces" title="Export filtered traces">Export</button>
                        <button class="btn btn-secondary btn-small" data-action="clear-trace-filters" title="Clear all filters">Clear</button>
                    </div>
                </div>
                <div class="trace-stats trace-stats-bar">
                    <span id="traceStatsCount">0 traces</span>
                    <span id="traceStatsSuccess" class="text-success">0 success</span>
                    <span id="traceStatsFailed" class="text-danger">0 failed</span>
                    <span id="traceStatsRetries" class="text-warning">0 with retries</span>
                    <span id="traceStatsAvgLatency">Avg: 0ms</span>
                </div>
                <div class="max-h-400 overflow-y-auto">
                    <table class="traces-table" id="tracesTable">
                        <thead>
                            <tr>
                                <th class="w-70">Time</th>
                                <th class="w-100">Trace ID</th>
                                <th>Path</th>
                                <th class="w-50">Model</th>
                                <th class="w-50">Attempts</th>
                                <th class="w-60">Queue</th>
                                <th class="w-60">Total</th>
                                <th class="w-50">Status</th>
                            </tr>
                        </thead>
                        <tbody id="tracesBody">
                            <tr>
                                <td colspan="8" class="text-center text-secondary">Loading traces...</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <!-- Enhanced Trace Detail Panel (Week 7) -->
                <div id="traceDetailPanel" class="trace-detail-panel trace-detail-panel--hidden bg-card rounded-md border">
                    <div class="trace-detail-header flex justify-between items-center p-12 border-b">
                        <div class="flex-row gap-12">
                            <span class="font-semibold">Trace Details</span>
                            <span id="traceDetailId" class="monospace text-xs text-secondary"></span>
                            <button class="btn btn-icon btn-small" data-action="copy-trace-id" title="Copy trace ID">Copy</button>
                        </div>
                        <div class="flex gap-6">
                            <button class="btn btn-secondary btn-small" data-action="copy-trace-json" title="Copy full trace as JSON">Export JSON</button>
                            <button class="btn btn-icon btn-small" data-action="close-trace-detail" title="Close">${svgIcon('x')}</button>
                        </div>
                    </div>
                    <div class="trace-detail-body p-12">
                        <!-- Summary Section -->
                        <div class="trace-summary grid-auto-fit mb-16">
                            <div class="trace-stat">
                                <div class="trace-stat-label">Status</div>
                                <div id="traceDetailStatus" class="font-semibold"></div>
                            </div>
                            <div class="trace-stat">
                                <div class="trace-stat-label">Model</div>
                                <div id="traceDetailModel" class="monospace text-sm"></div>
                            </div>
                            <div class="trace-stat">
                                <div class="trace-stat-label">Total Duration</div>
                                <div id="traceDetailDuration" class="monospace"></div>
                            </div>
                            <div class="trace-stat">
                                <div class="trace-stat-label">Attempts</div>
                                <div id="traceDetailAttempts"></div>
                            </div>
                            <div class="trace-stat">
                                <div class="trace-stat-label">Queue Time</div>
                                <div id="traceDetailQueue" class="monospace"></div>
                            </div>
                            <div class="trace-stat">
                                <div class="trace-stat-label">Key Used</div>
                                <div id="traceDetailKey" class="monospace text-sm"></div>
                            </div>
                        </div>
                        <!-- Timeline Section (Week 7) -->
                        <div class="trace-timeline-section mb-16">
                            <div class="section-title-sm">Request Timeline</div>
                            <div id="traceTimeline" class="trace-timeline bg-secondary rounded p-8 min-h-40"></div>
                        </div>
                        <!-- Attempts Section (Week 7) -->
                        <div class="trace-attempts-section mb-16">
                            <div class="section-title-sm">Attempt Details</div>
                            <div id="traceAttemptsList" class="text-sm"></div>
                        </div>
                        <!-- Error Section (if applicable) -->
                        <div id="traceErrorSection" class="mb-16" style="display: none;">
                            <div class="section-title-sm text-danger">Error Details</div>
                            <div id="traceErrorContent" class="monospace text-xs error-content"></div>
                        </div>
                        <!-- Raw Data Toggle -->
                        <details class="text-sm">
                            <summary class="cursor-pointer text-secondary">Raw Trace Data</summary>
                            <div id="traceDetailRaw" class="monospace text-xs raw-trace-content"></div>
                        </details>
                    </div>
                </div>
                <div data-testid="trace-not-found" id="traceNotFound" class="text-center text-secondary p-20" style="display:none;">
                    No trace found. Check the trace ID or wait for new requests to generate traces.
                </div>
            </div>

            <!-- Tab 3: Logs -->
            <div class="tab-panel" id="tab-logs">
                <div class="flex justify-between items-center mb-8">
                    <div class="flex-row gap-8">
                        <button class="ordering-indicator ordering-newest-bottom" data-action="toggle-ordering" data-tab="logs" title="Click to reverse ordering" aria-pressed="false">Newest at bottom ↓ <span class="autoscroll-dot"></span></button>
                        <span class="text-sm text-secondary">Recent log entries</span>
                    </div>
                    <button class="btn btn-secondary btn-small" data-action="clear-logs">Clear Logs</button>
                </div>
                <div class="logs-container flex-1-1-auto overflow-y-auto min-h-150 max-h-50vh" id="logsContainer"></div>
            </div>

            <!-- Tab 4: Queue -->
            <div class="tab-panel" id="tab-queue">
                <div class="info-grid mb-16">
                    <div class="info-item">
                        <div class="label">Queue Size</div>
                        <div class="value" id="queueSizeTab">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Max Queue</div>
                        <div class="value" id="queueMaxTab">100</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Active HTTP Requests</div>
                        <div class="value" id="connectionsTab">0</div>
                    </div>
                    <div class="info-item">
                        <div class="label">Max Concurrent</div>
                        <div class="value" id="connectionsMaxTab">100</div>
                    </div>
                </div>
                <div class="queue-progress">
                    <div class="progress-bar">
                        <div class="progress-fill" id="queueProgressTab" style="width: 0%"></div>
                    </div>
                    <div class="progress-label" id="queuePercentTab">
                        <span class="current-value">0/100</span>
                        <span>0%</span>
                    </div>
                </div>
                <div class="section-divider-block">
                    <div class="text-sm text-secondary mb-8">Backpressure Status</div>
                    <div id="backpressureStatus" class="text-sm">Normal operation</div>
                </div>
                <div class="section-divider-block" id="replayQueueSection" style="display: none;">
                    <div class="text-sm text-secondary mb-8">Replay Queue</div>
                    <div class="info-grid">
                        <div class="info-item">
                            <div class="label">Queued</div>
                            <div class="value" id="rqCurrent">0</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Succeeded</div>
                            <div class="value" id="rqSucceeded">0</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Failed</div>
                            <div class="value" id="rqFailed">0</div>
                        </div>
                        <div class="info-item">
                            <div class="label">Utilization</div>
                            <div class="value" id="rqUtilization">0%</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Tab 5: Circuit Status -->
            <div class="tab-panel" id="tab-circuit">
                <div class="flex-row gap-8 mb-8">
                    <button class="ordering-indicator ordering-newest-top" data-action="toggle-ordering" data-tab="circuit" title="Click to reverse ordering" aria-pressed="true">Newest at top ↓</button>
                </div>
                <div class="grid-two-col">
                    <div>
                        <div class="text-sm text-secondary mb-8">Health Score Distribution</div>
                        <div class="score-distribution mb-8">
                            <div class="score-segment excellent" id="tabScoreExcellent" style="width: 25%"></div>
                            <div class="score-segment good" id="tabScoreGood" style="width: 25%"></div>
                            <div class="score-segment fair" id="tabScoreFair" style="width: 25%"></div>
                            <div class="score-segment poor" id="tabScorePoor" style="width: 25%"></div>
                        </div>
                        <div class="info-grid">
                            <div class="info-item">
                                <div class="label">Excellent</div>
                                <div class="value" id="tabScoreExcellentCount">0</div>
                            </div>
                            <div class="info-item">
                                <div class="label">Good</div>
                                <div class="value" id="tabScoreGoodCount">0</div>
                            </div>
                            <div class="info-item">
                                <div class="label">Fair</div>
                                <div class="value" id="tabScoreFairCount">0</div>
                            </div>
                            <div class="info-item">
                                <div class="label">Poor</div>
                                <div class="value" id="tabScorePoorCount">0</div>
                            </div>
                        </div>
                    </div>
                    <div>
                        <div class="text-sm text-secondary mb-8">Circuit Timeline</div>
                        <div class="circuit-timeline" id="circuitTimeline">
                            <div class="text-secondary text-center p-20">No state changes yet</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div><!-- End .tab-content -->
    </div><!-- End #drawerContent -->
    </div><!-- End #bottomDrawer -->

    <!-- Side Panel (Milestone D) -->
    <div class="side-panel-backdrop" id="sidePanelBackdrop" data-action="close-panel"></div>
    <aside class="side-panel" id="sidePanel" data-testid="side-panel">
        <div class="side-panel-header">
            <h2 data-testid="panel-title">Request Details</h2>
            <button class="panel-close" data-action="close-panel" data-testid="panel-close">&times;</button>
        </div>
        <div class="side-panel-body" id="sidePanelBody">
            <div class="text-secondary text-center p-40-20">
                Select a request to view details
            </div>
        </div>
    </aside>

    <script src="/dashboard/dashboard-utils.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <!-- Phase 6: Modular JS files (split from dashboard.js) — load order matters -->
    <script src="/dashboard/js/store.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/sse.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/filters.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/context-menu.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/progressive-disclosure.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/anomaly.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/error-boundary.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/live-flow.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/tier-builder.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/dom-cache.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/traces.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/actions.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/polling.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/data.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>
    <script src="/dashboard/js/init.js?v=${ASSET_VERSION}"${nonce ? ` nonce="${nonce}"` : ''}></script>

    <!-- Keyboard Shortcuts Help Button (UX #2) -->
    <button class="shortcuts-help-btn" data-action="show-shortcuts-modal" title="Keyboard shortcuts (?)">?</button>

    <!-- Context Menu (UX #3) -->
    <div class="context-menu" id="contextMenu" role="menu" aria-label="Actions">
        <div class="context-menu-item" data-action="context-copy-id" role="menuitem" tabindex="-1">
            <span class="context-menu-item-icon">${svgIcon('clipboard')}</span>
            <span>Copy ID</span>
        </div>
        <div class="context-menu-item" data-action="context-filter-by-key" role="menuitem" tabindex="-1">
            <span class="context-menu-item-icon">${svgIcon('key')}</span>
            <span>Filter by Key</span>
        </div>
        <div class="context-menu-item" data-action="context-view-similar" role="menuitem" tabindex="-1">
            <span class="context-menu-item-icon">${svgIcon('search')}</span>
            <span>View Similar</span>
        </div>
        <div class="context-menu-divider" role="separator"></div>
        <div class="context-menu-item" data-action="context-investigate" role="menuitem" tabindex="-1">
            <span class="context-menu-item-icon">${svgIcon('alert-triangle')}</span>
            <span>Investigate Anomaly</span>
        </div>
    </div>

    </div><!-- End .app -->

</body>
</html>`;
}

module.exports = { generateDashboard };
