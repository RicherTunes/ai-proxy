// ========== SECURITY UTILITIES ==========
        // Use utility from dashboard-utils.js
        const escapeHtml = window.DashboardUtils?.escapeHtml || function(str) {
            if (str === null || str === undefined) return '';
            const div = document.createElement('div');
            div.textContent = String(str);
            return div.innerHTML;
        };

        // ========== MODEL DISPLAY NAME ==========
        // Use utility from dashboard-utils.js
        const chipModelName = window.DashboardUtils?.chipModelName || function(name) {
            if (!name) return '?';
            // Strip date suffix (8+ digit suffix like -20250929 or -20251001)
            let stripped = name.replace(/-\d{8,}$/, '');
            // Normalize version separators for claude models: "claude-sonnet-4-5" → "claude-sonnet-4.5"
            stripped = stripped.replace(/(claude-[a-z]+-\d)-(\d)$/, '$1.$2');
            return stripped;
        };

        // ========== TIME FORMATTING UTILITY ==========
        // Use utility from dashboard-utils.js
        const formatTimestamp = window.DashboardUtils?.formatTimestamp || function(ts, options) {
            if (ts == null) return '-';
            const d = new Date(ts);
            if (isNaN(d.getTime())) return '-';
            if (options && options.full) return d.toLocaleString();
            if (options && options.compact) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return d.toLocaleTimeString();
        };

        // ========== STATE RENDERERS ==========
        // Use utility from dashboard-utils.js
        const renderEmptyState = window.DashboardUtils?.renderEmptyState || function(message, options) {
            options = options || {};
            const icon = options.icon || '—';
            return `
                <div class="state-empty">
                    <span class="state-icon">${icon}</span>
                    <span class="state-message">${escapeHtml(message)}</span>
                </div>
            `;
        };

        const renderLoadingState = window.DashboardUtils?.renderLoadingState || function(message) {
            message = message || 'Loading...';
            return `
                <div class="state-loading">
                    <div class="spinner"></div>
                    <span class="state-message">${escapeHtml(message)}</span>
                </div>
            `;
        };

        const renderErrorState = window.DashboardUtils?.renderErrorState || function(error, options) {
            options = options || {};
            const retry = options.retryable
                ? '<button class="btn btn-small" onclick="location.reload()">Retry</button>'
                : '';
            return `
                <div class="state-error">
                    <span class="state-icon">⚠</span>
                    <span class="state-message">${escapeHtml(error)}</span>
                    ${retry}
                </div>
            `;
        };

        // Helper for table empty states with correct colspan
        const renderTableEmptyState = function(columnCount, message, options) {
            return `<tr><td colspan="${columnCount}">${renderEmptyState(message, options)}</td></tr>`;
        };

        // ========== ERROR CATEGORIZATION ==========
        // Categorize errors for appropriate display
        const categorizeError = function(err) {
            if (!err) return 'unknown';

            // Network errors (transient, retryable)
            if (err.name === 'AbortError' || err.message?.includes('abort')) {
                return 'cancelled';
            }
            if (err.message?.includes('fetch') || err.message?.includes('network') || err.message?.includes('ECONNREFUSED')) {
                return 'network';
            }
            if (err.message?.includes('timeout') || err.message?.includes('ETIMEDOUT')) {
                return 'timeout';
            }

            // HTTP errors
            if (err.status || err.statusCode) {
                const status = err.status || err.statusCode;
                if (status >= 500) return 'server';  // Server error - retryable
                if (status === 401 || status === 403) return 'auth';  // Auth error
                if (status === 404) return 'notfound';  // Not found
                if (status >= 400 && status < 500) return 'client';  // Client error
            }

            return 'unknown';
        };

        // Get error display message based on category
        const getErrorMessage = function(err, category) {
            const messages = {
                network: 'Network connection failed. Check your connection.',
                timeout: 'Request timed out. Please try again.',
                server: 'Server error. Please try again later.',
                auth: 'Authentication required. Please log in.',
                notfound: 'Resource not found.',
                client: 'Invalid request. Please check your input.',
                cancelled: 'Request cancelled.',
                unknown: err.message || 'An error occurred'
            };
            return messages[category] || messages.unknown;
        };

        // ========== TIME RANGE CONFIGURATION ==========
        // Single source of truth for time ranges
        const TIME_RANGES = {
            '5m':  { minutes: 5,     label: '(5 min)',     pollInterval: 10000 },
            '15m': { minutes: 15,    label: '(15 min)',    pollInterval: 10000 },
            '1h':  { minutes: 60,    label: '(1 hour)',    pollInterval: 10000 },
            '6h':  { minutes: 360,   label: '(6 hours)',   pollInterval: 30000 },
            '24h': { minutes: 1440,  label: '(24 hours)',  pollInterval: 60000 },
            '7d':  { minutes: 10080, label: '(7 days)',    pollInterval: 60000 }
        };
        const VALID_RANGES = Object.keys(TIME_RANGES);

        // ========== COMMON CONSTANTS ==========
        const CHART_UPDATE_INTERVAL = 10000;
        const HISTORY_FETCH_TIMEOUT = 30000;
        const MAX_RETRY_ATTEMPTS = 3;
        const TOAST_DISPLAY_DURATION = 3000;
        const TOAST_ANIMATION_DURATION = 300; // slideOut animation time before removal
        const DEFAULT_PAGE_SIZE = 50;
        const MAX_HISTORY_ITEMS = 1000;
        const SPARKLINE_WIDTH = 100;
        const SPARKLINE_HEIGHT = 20;
        const ANOMALY_THRESHOLD = 2;

        // ========== FEATURE DETECTION ==========
        // Detect which libraries are available for graceful degradation
        const FEATURES = {
            chartJs: typeof Chart !== 'undefined',
            d3: typeof d3 !== 'undefined',
            sortable: typeof Sortable !== 'undefined'
        };

        // Log missing features for debugging
        Object.entries(FEATURES).forEach(([feature, available]) => {
            if (!available) {
                console.warn(`${feature} is not available - ${feature} features will be degraded`);
            }
        });

        // ========== UX IMPROVEMENT CLASSES ==========

        // 1. FilterStateManager - Persistent Filters (UX #1)
        class FilterStateManager {
            constructor() {
                this.filters = this.loadFromURL();
                this.filterChipsContainer = null;
            }

            loadFromURL() {
                const params = new URLSearchParams(window.location.search);
                return {
                    status: params.get('status') || '',
                    model: params.get('model') || '',
                    keyId: params.get('keyId') || '',
                    timeRange: params.get('timeRange') || ''
                };
            }

            saveToURL() {
                const params = new URLSearchParams();
                Object.entries(this.filters).forEach(([key, value]) => {
                    if (value) params.set(key, value);
                });
                const path = window.location.pathname;
                const paramString = params.toString();
                const newURL = path + (paramString ? '?' + paramString : '');
                window.history.replaceState({}, '', newURL);
            }

            setFilter(key, value) {
                this.filters[key] = value;
                this.saveToURL();
                this.renderFilterChips();
                this.applyFilters();
            }

            removeFilter(key) {
                this.filters[key] = '';
                this.saveToURL();
                this.renderFilterChips();
                this.applyFilters();
            }

            renderFilterChips() {
                if (!this.filterChipsContainer) {
                    this.filterChipsContainer = document.querySelector('.filter-chips-container');
                    if (!this.filterChipsContainer) return;
                }

                this.filterChipsContainer.innerHTML = '';
                const filterLabels = {
                    status: 'Status',
                    model: 'Model',
                    keyId: 'Key ID',
                    timeRange: 'Time Range'
                };

                Object.entries(this.filters).forEach(([key, value]) => {
                    if (value) {
                        const chip = document.createElement('div');
                        chip.className = 'filter-chip active';
                        const label = filterLabels[key];
                        chip.innerHTML = `<span>${label}: ${value}</span>` +
                            `<span class="filter-chip-remove" data-filter="${key}">✕</span>`;
                        chip.querySelector('.filter-chip-remove').addEventListener('click', (function(keyCopy) {
                            return function() { thisCopy.removeFilter(keyCopy); }.bind(thisCopy);
                        })(key).bind(this));
                        this.filterChipsContainer.appendChild(chip);
                    }
                });
            }

            applyFilters() {
                // Emit custom event for filter changes
                window.dispatchEvent(new CustomEvent('filters-changed', { detail: this.filters }));
            }

            init() {
                this.renderFilterChips();
                window.addEventListener('popstate', () => {
                    this.filters = this.loadFromURL();
                    this.renderFilterChips();
                    this.applyFilters();
                });
            }
        }

        // 9. URLStateManager - Shareable URLs (UX #9)
        class URLStateManager {
            constructor() {
                this.state = {};
                this.init();
            }

            init() {
                // Load state from hash
                this.loadFromHash();

                // Listen for hash changes
                window.addEventListener('hashchange', () => this.loadFromHash());
            }

            loadFromHash() {
                const hash = window.location.hash.slice(1);
                if (!hash) {
                    this.state = {};
                    return;
                }

                // Parse hash parameters (e.g., #trace=xxx&compare=yyy)
                const params = new URLSearchParams(hash);
                this.state = {
                    trace: params.get('trace') || null,
                    compare: params.get('compare') || null,
                    tab: params.get('tab') || null
                };

                // Handle deep linking to request details
                if (this.state.trace) {
                    this.openRequestDetails(this.state.trace);
                }
            }

            setState(key, value) {
                this.state[key] = value;
                this.updateHash();
            }

            updateHash() {
                const params = new URLSearchParams();
                Object.entries(this.state).forEach(([key, value]) => {
                    if (value) params.set(key, value);
                });
                window.location.hash = params.toString() ? params.toString() : '';
            }

            getShareableURL() {
                return window.location.href;
            }

            openRequestDetails(traceId) {
                // Find and open request in side panel
                const event = new CustomEvent('open-request-details', { detail: { traceId } });
                window.dispatchEvent(event);
            }
        }

        // Helper: Debounce function (reusable component)
        function debounce(fn, delay) {
            let timeoutId;
            return function(...args) {
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => fn.apply(this, args), delay);
            };
        }

        // Helper: Escape regex special characters correctly
        function escapeRegex(text) {
            return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        // 7. GlobalSearchManager - Global Search (UX #7)
        class GlobalSearchManager {
            constructor() {
                this.SEARCH_DEBOUNCE_DELAY = 300;
                this.HISTORY_HIDE_DELAY = 200;
                this.searchInput = null;
                this.historyDropdown = null;
                this.searchHistory = this.loadSearchHistory();
                this.currentMatchIndex = -1;
                this.matches = [];
                this.lastQuery = null;
                this.init();
            }

            init() {
                this.searchInput = document.getElementById('globalSearchInput');
                this.historyDropdown = document.getElementById('searchHistoryDropdown');

                if (!this.searchInput) return;

                // Create debounced search
                this.debouncedPerformSearch = debounce((query) => {
                    this.performSearch(query);
                    this._setSearching(false);
                }, this.SEARCH_DEBOUNCE_DELAY);

                // Input event listener
                this.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
                this.searchInput.addEventListener('focus', () => this.showHistory());
                this.searchInput.addEventListener('blur', () => {
                    setTimeout(() => this.hideHistory(), this.HISTORY_HIDE_DELAY);
                });

                // Keyboard shortcut Ctrl+K / Cmd+K
                document.addEventListener('keydown', (e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                        e.preventDefault();
                        this.searchInput.focus();
                        this.searchInput.select();
                    }
                });

                // Close dropdown on Escape
                this.searchInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') {
                        this.hideHistory();
                    }
                });
            }

            handleSearch(query) {
                if (!query.trim()) {
                    this.clearHighlights();
                    this._setSearching(false);
                    return;
                }

                // Skip if same as last query (performance optimization)
                if (query === this.lastQuery) {
                    return;
                }
                this.lastQuery = query;

                // Save to history
                this.saveSearch(query);

                // Show searching indicator and trigger debounced search
                this._setSearching(true);
                this.debouncedPerformSearch(query);
            }

            _setSearching(isSearching) {
                const indicator = document.getElementById('searchingIndicator');
                if (indicator) {
                    indicator.style.display = isSearching ? 'inline' : 'none';
                }
            }

            performSearch(query) {
                // Use correct escapeRegex function (Phase 1 fix)
                const escaped = escapeRegex(query);
                const regex = new RegExp(escaped, 'gi');
                this.matches = [];

                // Limit scanned elements for performance (Scalability Guardrails)
                const maxScanned = 1000;
                let scanned = 0;

                // Search in request traces
                document.querySelectorAll('.request-row, .request-item, .log-item, .trace-item').forEach(item => {
                    if (scanned >= maxScanned) {
                        console.warn('[GlobalSearch] Limited to', maxScanned, 'elements for performance');
                        return;
                    }
                    scanned++;

                    const text = item.textContent;
                    if (regex.test(text)) {
                        this.matches.push(item);
                    }
                });

                // Track debug hooks for E2E testing
                if (window.__DASHBOARD_DEBUG__?.search) {
                    window.__DASHBOARD_DEBUG__.search.runs++;
                    window.__DASHBOARD_DEBUG__.search.lastQuery = query;
                }

                // Highlight matches
                this.highlightMatches(regex);
            }

            highlightMatches(regex) {
                this.clearHighlights();

                this.matches.forEach(item => {
                    const walker = document.createTreeWalker(
                        item,
                        NodeFilter.SHOW_TEXT,
                        null,
                        false
                    );

                    const nodesToReplace = [];
                    let node;
                    while (node = walker.nextNode()) {
                        if (regex.test(node.textContent)) {
                            nodesToReplace.push(node);
                        }
                    }

                    nodesToReplace.forEach(node => {
                        const text = node.textContent;
                        const fragment = document.createDocumentFragment();
                        let lastIndex = 0;
                        regex.lastIndex = 0;
                        let match;
                        while ((match = regex.exec(text)) !== null) {
                            if (match.index > lastIndex) {
                                fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                            }
                            const mark = document.createElement('mark');
                            mark.className = 'search-highlight';
                            mark.textContent = match[0];
                            fragment.appendChild(mark);
                            lastIndex = regex.lastIndex;
                            if (match[0].length === 0) { regex.lastIndex++; break; }
                        }
                        if (lastIndex < text.length) {
                            fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
                        }
                        node.parentNode.replaceChild(fragment, node);
                    });
                });

                // Scroll to first match
                if (this.matches.length > 0) {
                    this.matches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }

            clearHighlights() {
                document.querySelectorAll('.search-highlight').forEach(mark => {
                    const parent = mark.parentNode;
                    parent.replaceChild(document.createTextNode(mark.textContent), mark);
                    parent.normalize();
                });
            }

            showHistory() {
                if (!this.historyDropdown) return;

                this.historyDropdown.innerHTML = '';
                this.searchHistory.forEach(query => {
                    const item = document.createElement('div');
                    item.className = 'search-history-item';
                    item.textContent = query;
                    item.addEventListener('click', () => {
                        this.searchInput.value = query;
                        this.handleSearch(query);
                        this.hideHistory();
                    });
                    this.historyDropdown.appendChild(item);
                });

                this.historyDropdown.classList.add('visible');
            }

            hideHistory() {
                if (this.historyDropdown) {
                    this.historyDropdown.classList.remove('visible');
                }
            }

            loadSearchHistory() {
                const stored = localStorage.getItem('dashboard-search-history');
                return stored ? JSON.parse(stored) : [];
            }

            saveSearch(query) {
                if (!query.trim()) return;

                this.searchHistory = this.searchHistory.filter(q => q !== query);
                this.searchHistory.unshift(query);
                this.searchHistory = this.searchHistory.slice(0, 10);

                localStorage.setItem('dashboard-search-history', JSON.stringify(this.searchHistory));
            }
        }

        // 3. ContextMenuManager - Quick Actions (UX #3)
        class ContextMenuManager {
            constructor() {
                this.menu = null;
                this.currentTarget = null;
                this.init();
            }

            init() {
                this.menu = document.getElementById('contextMenu');
                if (!this.menu) return;

                // Close on click outside
                document.addEventListener('click', (e) => {
                    if (!this.menu.contains(e.target)) {
                        this.hide();
                    }
                });

                // Close on Escape
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') {
                        this.hide();
                    }
                });

                // Handle menu item clicks
                this.menu.querySelectorAll('.context-menu-item').forEach(item => {
                    item.addEventListener('click', (e) => {
                        const action = item.dataset.action;
                        this.handleAction(action);
                        this.hide();
                    });
                });

                // Attach to request items
                this.attachToItems();
            }

            attachToItems() {
                // Use event delegation
                document.addEventListener('contextmenu', (e) => {
                    const target = e.target.closest('.request-row, .request-item, .log-item, .trace-item, .key-item');
                    if (target) {
                        e.preventDefault();
                        this.show(e.clientX, e.clientY, target);
                    }
                });
            }

            show(x, y, target) {
                this.currentTarget = target;
                this.menu.style.left = x + 'px';
                this.menu.style.top = y + 'px';
                this.menu.classList.add('visible');
            }

            hide() {
                this.menu.classList.remove('visible');
                this.currentTarget = null;
            }

            handleAction(action) {
                if (!this.currentTarget) return;

                switch (action) {
                    case 'context-copy-id':
                        this.copyId();
                        break;
                    case 'context-filter-by-key':
                        this.filterByKey();
                        break;
                    case 'context-view-similar':
                        this.viewSimilar();
                        break;
                    case 'context-investigate':
                        this.investigateAnomaly();
                        break;
                }
            }

            copyId() {
                const id = this.currentTarget.dataset.id || this.currentTarget.dataset.traceId;
                if (id) {
                    navigator.clipboard.writeText(id);
                    showToast('ID copied to clipboard');
                }
            }

            filterByKey() {
                const keyId = this.currentTarget.dataset.keyId;
                if (keyId && window.filterManager) {
                    window.filterManager.setFilter('keyId', keyId);
                }
            }

            viewSimilar() {
                const model = this.currentTarget.dataset.model;
                if (model) {
                    window.dispatchEvent(new CustomEvent('view-similar', { detail: { model } }));
                }
            }

            investigateAnomaly() {
                window.dispatchEvent(new CustomEvent('investigate-anomaly', {
                    detail: { element: this.currentTarget }
                }));
            }
        }

        // 4. ProgressiveDisclosureManager - Collapsible Sections (UX #4)
        class ProgressiveDisclosureManager {
            constructor() {
                this.init();
            }

            init() {
                // Attach to all collapsible sections
                document.querySelectorAll('.collapsible-header').forEach(header => {
                    header.addEventListener('click', () => {
                        const section = header.closest('.collapsible-section');
                        section.classList.toggle('collapsed');
                    });
                });
            }

            createCollapsible(title, content, collapsed) {
                if (collapsed === undefined) collapsed = false;
                const section = document.createElement('div');
                section.className = `collapsible-section${collapsed ? ' collapsed' : ''}`;

                section.innerHTML = `
                    <div class="collapsible-header">
                        <div class="collapsible-header-title">
                            <span>${title}</span>
                        </div>
                        <svg class="collapsible-chevron" viewBox="0 0 20 20">
                            <path d="M10 14l-5-5h10l-5 5z"/>
                        </svg>
                    </div>
                    <div class="collapsible-content">
                        ${content}
                    </div>`;

                // Attach click handler
                section.querySelector('.collapsible-header').addEventListener('click', function() {
                    section.classList.toggle('collapsed');
                });

                return section;
            }
        }

        // 8. AnomalyDetectionManager - Anomaly Detection (UX #8)
        class AnomalyDetectionManager {
            constructor() {
                this.init();
            }

            init() {
                window.addEventListener('investigate-anomaly', (e) => {
                    this.investigate(e.detail.element);
                });
            }

            investigate(element) {
                const traceId = element.dataset.traceId || element.dataset.id;
                if (!traceId) return;

                // Show investigation panel or navigate
                showToast(`Investigating anomaly for request: ${traceId}`);

                // You could open side panel with detailed analysis
                window.dispatchEvent(new CustomEvent('open-request-details', {
                    detail: { traceId, focusAnomaly: true }
                }));
            }

            createSparkline(dataPoints) {
                const width = 60;
                const height = 20;
                const max = Math.max.apply(Math, dataPoints);
                const min = Math.min.apply(Math, dataPoints);
                const range = max - min || 1;

                const points = dataPoints.map(function(val, i) {
                    const x = (i / (dataPoints.length - 1)) * width;
                    const y = height - ((val - min) / range) * height;
                    return `${x},${y}`;
                }).join(' ');

                return `<svg class="anomaly-sparkline" viewBox="0 0 ${width} ${height}">
                    <path d="M${points}" />
                </svg>`;
            }

            detectAnomaly(value, baseline, threshold = 2) {
                const stdDev = Math.sqrt(baseline.reduce((sum, val) => sum + Math.pow(val - value, 2), 0) / baseline.length);
                const mean = baseline.reduce((sum, val) => sum + val, 0) / baseline.length;
                return Math.abs(value - mean) > threshold * stdDev;
            }
        }

        // ========== STATE MANAGEMENT ==========
        const STATE = {
            keys: { data: [], selected: null },
            keysData: [],  // Full key statistics data (for heatmap, details panel)
            selectedKeyIndex: null,  // Currently selected key index for details panel
            charts: { request: null, latency: null, error: null, dist: null },
            settings: { timeRange: '1h', theme: 'dark', density: 'comfortable', autoScroll: true, activeTab: 'live' },
            connection: { status: 'connected', lastUpdate: null, staleData: false },
            history: { points: [], range: '15m', cache: {}, lastTier: null },  // Added lastTier for validation
            sse: { eventSource: null, connected: false },
            densityOptions: ['compact', 'comfortable', 'spacious'],
            traces: [],
            apiTraces: [],  // Week 2: Traces from /traces API
            circuitEvents: [],
            // Side Panel (Milestone D)
            requestsHistory: [],  // Full request objects for side panel drill-down
            selectedRequestId: null,
            models: [],  // Dynamic model IDs from /models endpoint
            modelsData: {},  // Full model objects with metadata (displayName, tier, pricing, etc.)
            routingData: null  // Cached model routing config from /model-routing endpoint
        };

        // ActionTypes for Redux-style store
        const ActionTypes = {
            SSE_CONNECTED: 'SSE_CONNECTED',
            SSE_DISCONNECTED: 'SSE_DISCONNECTED',
            SSE_MESSAGE_RECEIVED: 'SSE_MESSAGE_RECEIVED',
            REQUEST_RECEIVED: 'REQUEST_RECEIVED',
            KPI_UPDATED: 'KPI_UPDATED',
            SELECT_REQUEST: 'SELECT_REQUEST',
            CLEAR_GAP_DETECTED: 'CLEAR_GAP_DETECTED'
        };

        // Redux-style store for state management
        const store = {
            getState: () => ({
                requests: { items: STATE.requestsHistory },
                connection: {
                    status: STATE.connection.status,
                    clientId: STATE.sse.clientId || null,
                    lastSeq: STATE.sse.lastSeq || 0,
                    lastRequestSeq: STATE.sse.lastRequestSeq || 0,
                    lastTs: STATE.sse.lastTs || null,
                    gapDetected: STATE.sse.gapDetected || false
                },
                selectedRequestId: STATE.selectedRequestId
            }),
            dispatch: (action) => {
                switch (action.type) {
                    case ActionTypes.SELECT_REQUEST:
                        STATE.selectedRequestId = action.payload;
                        break;
                    case ActionTypes.SSE_CONNECTED:
                        STATE.connection.status = 'connected';
                        STATE.sse.clientId = action.payload.clientId;
                        STATE.sse.connected = true;
                        // Merge recent requests with existing, preserving already-added requests
                        if (action.payload.recentRequests && action.payload.recentRequests.length > 0) {
                            const existingById = new Map(STATE.requestsHistory.map(r => [r.requestId || `${r.timestamp}-${r.keyIndex ?? 0}`, r]));
                            for (const req of action.payload.recentRequests) {
                                const id = req.requestId || `${req.timestamp}-${req.keyIndex ?? 0}`;
                                if (!existingById.has(id)) {
                                    existingById.set(id, req);
                                }
                            }
                            STATE.requestsHistory = Array.from(existingById.values());
                        }
                        break;
                    case ActionTypes.SSE_DISCONNECTED:
                        STATE.connection.status = 'disconnected';
                        STATE.sse.connected = false;
                        STATE.sse.clientId = null;
                        break;
                    case ActionTypes.SSE_MESSAGE_RECEIVED: {
                        const { seq, ts, eventType } = action.payload;
                        STATE.sse.lastSeq = seq;
                        STATE.sse.lastTs = ts;
                        if (eventType === 'request') {
                            const expectedSeq = (STATE.sse.lastRequestSeq || 0) + 1;
                            // Gap detected if sequence number skips (e.g., seq=5 when expected=1)
                            if (seq > expectedSeq) {
                                STATE.sse.gapDetected = true;
                            }
                            STATE.sse.lastRequestSeq = seq;
                        }
                        break;
                    }
                    case ActionTypes.REQUEST_RECEIVED:
                        STATE.requestsHistory.push(action.payload);
                        // Keep last MAX_HISTORY_ITEMS requests
                        if (STATE.requestsHistory.length > MAX_HISTORY_ITEMS) {
                            STATE.requestsHistory = STATE.requestsHistory.slice(-MAX_HISTORY_ITEMS);
                        }
                        // Trigger UI render if callback is set (for E2E tests)
                        if (store._onRequestReceived) {
                            store._onRequestReceived(action.payload);
                        }
                        break;
                    case ActionTypes.CLEAR_GAP_DETECTED:
                        STATE.sse.gapDetected = false;
                        break;
                }
                return action;
            }
        };

        // Initialize SSE state properties
        STATE.sse.clientId = null;
        STATE.sse.lastSeq = 0;
        STATE.sse.lastRequestSeq = 0;
        STATE.sse.lastTs = null;
        STATE.sse.gapDetected = false;

        const Actions = {
            selectRequest: (requestId) => ({ type: ActionTypes.SELECT_REQUEST, payload: requestId }),
            sseConnected: (payload) => ({ type: ActionTypes.SSE_CONNECTED, payload }),
            sseDisconnected: () => ({ type: ActionTypes.SSE_DISCONNECTED }),
            sseMessageReceived: (seq, ts, eventType) => ({ type: ActionTypes.SSE_MESSAGE_RECEIVED, payload: { seq, ts, eventType } }),
            requestReceived: (request) => ({ type: ActionTypes.REQUEST_RECEIVED, payload: request }),
            clearGapDetected: () => ({ type: ActionTypes.CLEAR_GAP_DETECTED })
        };

        // Expose for E2E testing and debugging (only when ?debug=1 is present)
        // This reduces attack surface in production by not exposing internal state
        const urlParams = new URLSearchParams(window.location.search);
        const debugEnabled = urlParams.get('debug') === '1';
        if (debugEnabled) {
            window.__DASHBOARD_STORE__ = store;
            window.__DASHBOARD_ACTIONS__ = Actions;
            window.__DASHBOARD_ACTION_TYPES__ = ActionTypes;
            // Phase 0: E2E debug hooks — extend existing (use ||= to not overwrite)
            window.__DASHBOARD_DEBUG__ ||= {};
            window.__DASHBOARD_DEBUG__.search ||= { runs: 0, lastQuery: null };
            window.__DASHBOARD_DEBUG__.errors ||= { toastsShown: 0, lastToast: null };
            window.__DASHBOARD_DEBUG__.loading ||= { inFlight: 0 };
            // Test helper: inject request into stream for deterministic search testing
            window.__DASHBOARD_DEBUG__.addRequestToStream = function(req) {
                STATE.requestsHistory.push(req);
                updateTracesTable(req);
                renderTracesTable();
            };
            console.info('[Dashboard] Debug mode enabled - store exposed on window');
        }

        let requestChart, latencyChart, errorChart, distChart;
        let routingTierChart, routingSourceChart, routing429Chart;
        let autoScrollLogs = true;
        let numberTransitions = new Map(); // Track ongoing number transitions

        // Store interval IDs for cleanup
        let statsIntervalId = null;
        let historyIntervalId = null;
        let historyFetchController = null; // For aborting pending requests
        let lastHistoryFetchId = 0; // For tracking most recent fetch
        let historyUpdatePending = false; // Track if an update is in progress
        let logsIntervalId = null;
        let histogramIntervalId = null;
        let costIntervalId = null;
        let comparisonIntervalId = null;
        let authIntervalId = null;
        let staleCheckIntervalId = null;
        let requestPollingIntervalId = null;

        function updateRequestCountBadge(count) {
            const badge = document.getElementById('requestCountBadge');
            if (badge) badge.textContent = String(count || 0);
        }

        // ========== SIDE PANEL (Milestone D) ==========
        function openSidePanel(requestId) {
            store.dispatch(Actions.selectRequest(requestId));
            const panel = document.getElementById('sidePanel');
            const backdrop = document.getElementById('sidePanelBackdrop');
            if (panel) panel.classList.add('open');
            if (backdrop) backdrop.classList.add('visible');
            renderRequestDetails(requestId);
        }

        function closeSidePanel() {
            store.dispatch(Actions.selectRequest(null));
            const panel = document.getElementById('sidePanel');
            const backdrop = document.getElementById('sidePanelBackdrop');
            if (panel) panel.classList.remove('open');
            if (backdrop) backdrop.classList.remove('visible');
        }

        function renderRequestDetails(requestId) {
            const body = document.getElementById('sidePanelBody');
            const request = STATE.requestsHistory.find(r =>
                (r.requestId || `${r.timestamp}-${r.keyIndex ?? 0}`) === requestId
            );

            if (!request) {
                body.innerHTML = '<div style="color: var(--text-secondary);">Request not found</div>';
                return;
            }

            const formatTime = (ts) => formatTimestamp(ts, {full: true});
            const statusCode = request.status || (request.error ? 500 : 200);
            const statusClass = statusCode >= 400 ? 'error' : statusCode >= 300 ? 'warning' : 'success';

            // Helper for copyable values
            const copyBtn = (value) => value && value !== 'N/A'
                ? `<button class="copy-btn" data-action="copy-value" data-value="${escapeHtml(String(value))}" title="Copy">📋</button>`
                : '';

            // Build retry timeline if there's retry info
            let retryTimelineHtml = '';
            if (request.retries > 0 || request.retryDecision || request.evidence) {
                const attempts = request.attempt || 1;
                const decision = request.retryDecision || 'unknown';
                const evidence = request.evidence || {};

                retryTimelineHtml = `
                    <div class="retry-timeline">
                        <div class="retry-timeline-title">Retry Timeline</div>
                        <div class="retry-step">
                            <div class="retry-step-marker ${attempts === 1 && !request.error ? 'success' : 'pending'}">1</div>
                            <div class="retry-step-content">
                                <div class="retry-step-label">Initial Request</div>
                                <div class="retry-step-detail">Key ${request.keyIndex ?? 0} • ${request.latencyMs || request.latency || 0}ms</div>
                            </div>
                        </div>
                        ${request.retries > 0 ? `
                        <div class="retry-step">
                            <div class="retry-step-marker ${request.error ? 'error' : 'success'}">${attempts}</div>
                            <div class="retry-step-content">
                                <div class="retry-step-label">Retry Attempt ${attempts - 1}</div>
                                <div class="retry-step-detail">Decision: ${escapeHtml(decision)}</div>
                                ${evidence.retryAfterMs ? `<div class="retry-step-detail">Retry-After: ${evidence.retryAfterMs}ms</div>` : ''}
                            </div>
                        </div>
                        ` : ''}
                        ${evidence.source ? `
                        <div class="retry-step">
                            <div class="retry-step-marker pending">!</div>
                            <div class="retry-step-content">
                                <div class="retry-step-label">Evidence</div>
                                <div class="retry-step-detail">Source: ${escapeHtml(evidence.source)}</div>
                                ${evidence.upstreamHost ? `<div class="retry-step-detail">Host: ${escapeHtml(evidence.upstreamHost)}</div>` : ''}
                            </div>
                        </div>
                        ` : ''}
                    </div>
                `;
            }

            body.innerHTML = `
                <div class="detail-row">
                    <span class="detail-label">Request ID</span>
                    <span class="detail-value">${escapeHtml(requestId)}${copyBtn(requestId)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Timestamp</span>
                    <span class="detail-value">${formatTime(request.timestamp)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Model</span>
                    <span class="detail-value">${escapeHtml(request.originalModel || 'N/A')}${copyBtn(request.originalModel)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Mapped To</span>
                    <span class="detail-value">${escapeHtml(request.mappedModel || 'N/A')}${copyBtn(request.mappedModel)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Status</span>
                    <span class="detail-value" style="color: var(--${statusClass})">${statusCode}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Latency</span>
                    <span class="detail-value">${request.latency || request.latencyMs || 'N/A'}ms</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Input Tokens</span>
                    <span class="detail-value">${request.inputTokens ?? 'N/A'}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Output Tokens</span>
                    <span class="detail-value">${request.outputTokens ?? 'N/A'}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Cost</span>
                    <span class="detail-value">${request.cost != null ? '$' + request.cost.toFixed(4) : 'N/A'} (${request.costStatus || 'unknown'})${copyBtn(request.cost != null ? request.cost.toFixed(4) : null)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Key</span>
                    <span class="detail-value">K${request.keyIndex ?? 'N/A'}${request.keyPrefix ? ' (' + escapeHtml(request.keyPrefix) + ')' : ''}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Retries</span>
                    <span class="detail-value">${request.retries ?? 0}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Streaming</span>
                    <span class="detail-value">${request.streaming ? 'Yes' : 'No'}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Path</span>
                    <span class="detail-value">${escapeHtml(request.path || '/v1/messages')}</span>
                </div>
                ${request.error || request.errorType ? `
                <div class="detail-row">
                    <span class="detail-label">Error</span>
                    <span class="detail-value" style="color: var(--error)">${escapeHtml(request.errorType || request.error)}${copyBtn(request.errorType || request.error)}</span>
                </div>
                ` : ''}
                ${retryTimelineHtml}
            `;
        }

        // Expose openSidePanel on window for debugging
        window.openSidePanel = openSidePanel;

        // ========== EVENT DELEGATION (Milestone 2 - XSS Prevention) ==========
        // Central event handler to prevent XSS attacks from inline handlers
        document.addEventListener('click', function(event) {
            const target = event.target;
            const action = target.dataset?.action;

            if (!action) {
                // Check if parent has action (for buttons with spans inside)
                const parent = target.closest('[data-action]');
                if (!parent) return;
                return handleAction(parent, event);
            }

            handleAction(target, event);
        });

            // Close overflow menu when clicking outside
            document.addEventListener('click', function(e) {
                const container = document.getElementById('overflowMenuContainer');
                if (container && !container.contains(e.target)) {
                    const dropdown = document.getElementById('overflowMenuDropdown');
                    const trigger = document.getElementById('overflowMenuTrigger');
                    if (dropdown) dropdown.classList.remove('open');
                    if (trigger) trigger.setAttribute('aria-expanded', 'false');
                }
            });

        function handleAction(element, event) {
            const action = element.dataset.action;

            // Alert Bar click handlers (special case - check closest containers)
            const target = event.target;
            if (target.closest('#alertIssuesContainer')) {
                document.querySelector('.health-ribbon')?.scrollIntoView({ behavior: 'smooth' });
                return;
            }
            if (target.closest('#alertCircuitsContainer')) {
                document.querySelector('.keys-section')?.scrollIntoView({ behavior: 'smooth' });
                return;
            }
            if (target.closest('#alertQueueContainer')) {
                document.querySelector('.queue-stats')?.scrollIntoView({ behavior: 'smooth' });
                return;
            }

            switch (action) {
                case 'close-modal':
                    if (element.dataset.modal === 'shortcuts') closeShortcutsModal(event);
                    if (element.dataset.modal === 'key-override') closeKeyOverrideModal(event);
                    break;
                case 'close-key-override-modal':
                    closeKeyOverrideModal();
                    break;
                case 'add-override':
                    addOverride();
                    break;
                case 'save-key-overrides':
                    saveKeyOverrides();
                    break;
                case 'set-time-range':
                    setTimeRange(element.dataset.range);
                    break;
                case 'toggle-theme':
                    toggleTheme();
                    break;
                case 'set-density':
                    setDensity(element.dataset.density);
                    break;
                case 'export-data':
                    exportData();
                    break;
                case 'share-url':
                    shareURL();
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
                    controlAction('pause');
                    break;
                case 'control-resume':
                    controlAction('resume');
                    break;
                case 'reload-keys':
                    reloadKeys();
                    break;
                case 'dismiss-issues':
                    dismissIssues();
                    break;
                case 'reopen-issues':
                    localStorage.removeItem('issues-dismissed');
                    document.getElementById('issuesReopenBadge').style.display = 'none';
                    if (lastIssuesStats) updateIssuesPanel(lastIssuesStats);
                    break;
                case 'reset-all-circuits':
                    resetAllCircuits();
                    break;
                case 'clear-queue':
                    clearQueue();
                    break;
                case 'export-diagnostics':
                    exportDiagnostics();
                    break;
                case 'toggle-fullscreen':
                    toggleFullscreen(element.dataset.chart);
                    break;
                case 'open-key-override-modal':
                    openKeyOverrideModal(STATE.selectedKeyIndex);
                    break;
                case 'close-key-details':
                    closeKeyDetails();
                    break;
                case 'force-circuit-state':
                    forceCircuitState(element.dataset.state);
                    break;
                case 'reset-stats':
                    resetStats();
                    break;
                case 'switch-tab':
                    switchTab(element.dataset.tab);
                    break;
                case 'switch-dock-tab': {
                    const tabName = element.dataset.dockTab;
                    if (tabName) {
                        switchDockTab(tabName);
                        const drawer = document.getElementById('bottomDrawer');
                        if (drawer && !drawer.classList.contains('expanded')) {
                            drawer.querySelector('.drawer-header').click();
                        }
                    }
                    break;
                }
                case 'switch-routing-tab':
                    switchRoutingTab(element.dataset.routingTab);
                    break;
                case 'switch-page':
                    switchPage(element.dataset.page);
                    break;
                case 'switch-request-tab': {
                    const reqTab = element.dataset.tab;
                    switchRequestTab(reqTab);
                    break;
                }
                case 'clear-logs':
                    clearLogs();
                    break;
                case 'close-toast':
                    event.target.parentElement.remove();
                    break;
                case 'handle-issue-action':
                    handleIssueAction(element.dataset.issueAction, parseInt(element.dataset.issueData, 10));
                    break;
                case 'select-key':
                    selectKey(parseInt(element.dataset.keyIndex, 10));
                    break;
                case 'remove-override':
                    removeOverride(element.dataset.claude);
                    break;
                    case 'toggle-overflow-menu': {
                        const dropdown = document.getElementById('overflowMenuDropdown');
                        const trigger = document.getElementById('overflowMenuTrigger');
                        if (dropdown && trigger) {
                            const isOpen = dropdown.classList.toggle('open');
                            trigger.setAttribute('aria-expanded', String(isOpen));
                        }
                        break;
                    }
                case 'toggle-drawer': {
                    const drawer = document.getElementById('bottomDrawer');
                    if (drawer) {
                        const expanded = drawer.classList.toggle('expanded');
                        const toggleBtn = drawer.querySelector('.drawer-toggle');
                        if (toggleBtn) toggleBtn.innerHTML = expanded ? '▼' : '▲';
                        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(expanded));
                        localStorage.setItem('drawer-expanded', expanded ? 'true' : 'false');
                    }
                    break;
                }
                // Side Panel actions (Milestone D)
                case 'close-panel':
                    closeSidePanel();
                    break;
                case 'view-request':
                    openSidePanel(element.dataset.requestId);
                    break;
                // Week 2 UX actions
                case 'filter-change':
                    applyFilters();
                    break;
                case 'clear-filters':
                    clearFilters();
                    break;
                case 'toggle-autoscroll':
                    toggleAutoScroll();
                    break;
                case 'jump-to-latest':
                    jumpToLatest();
                    break;
                case 'toggle-ordering': {
                    const tabId = element.dataset.tab || 'live';
                    toggleTabOrdering(tabId);
                    break;
                }
                case 'copy-value':
                    copyToClipboard(element.dataset.value, element);
                    break;
                // Routing Observability
                case 'set-routing-time': {
                    const range = element.dataset.range;
                    routingObsTimeRange = range;
                    document.querySelectorAll('#routingTimeSelector .time-range-btn').forEach(b =>
                        b.classList.toggle('active', b.dataset.range === range));
                    const minutes = ROUTING_TIME_MINUTES[range] || 5;
                    fetch(`/history?minutes=${minutes}`)
                        .then(r => {
                            if (!r.ok) throw new Error(`History fetch failed: ${r.status}`);
                            return r.json();
                        })
                        .then(h => { updateRoutingObsKPIs(h); updateRouting429Chart(h); })
                        .catch(err => console.error('Routing history fetch error:', err));
                    break;
                }
                case 'copy-routing-snapshot': {
                    const snapshot = {
                        timestamp: new Date().toISOString(),
                        timeRange: routingObsTimeRange,
                        stats: modelRoutingData?.stats || null,
                        cooldowns: modelRoutingData?.cooldowns || null,
                        config: { cooldown: modelRoutingData?.config?.cooldown || null }
                    };
                    copyToClipboard(JSON.stringify(snapshot, null, 2), element);
                    break;
                }
                // Week 2 - Request Traces
                case 'load-traces':
                    loadTracesFromAPI();
                    break;
                case 'trace-filter-change':
                    loadTracesFromAPI();
                    break;
                case 'close-trace-detail':
                    closeTraceDetail();
                    break;
                case 'select-tenant':
                    selectTenant(element.value);
                    break;
                case 'show-trace':
                    showTraceDetail(element.dataset.traceId);
                    break;
                // Week 7 - Enhanced Trace Viewer
                case 'trace-search':
                    searchTraceById();
                    break;
                case 'export-traces':
                    exportTraces();
                    break;
                case 'clear-trace-filters':
                    clearTraceFilters();
                    break;
                case 'copy-trace-id':
                    copyTraceId();
                    break;
                case 'copy-trace-json':
                    copyTraceJson();
                    break;
            }
        }

        // Mouse events delegation
        document.addEventListener('mouseenter', function(event) {
            const target = event.target;
            const mouseenter = target.dataset?.mouseenter;

            if (mouseenter === 'show-heatmap-tooltip') {
                const index = parseInt(target.dataset.keyIndexTooltip, 10);
                showHeatmapTooltip(event, index);
            }
        }, true);

        document.addEventListener('mouseleave', function(event) {
            const target = event.target;
            const mouseleave = target.dataset?.mouseleave;

            if (mouseleave === 'hide-heatmap-tooltip') {
                hideHeatmapTooltip();
            }
        }, true);

        // ========== AUTH STATE (Milestone 1) ==========
        const AUTH_STATE = {
            enabled: false,
            tokensConfigured: 0,
            tokensRequired: false,
            authenticated: false,
            token: null  // Stored token for authenticated requests
        };

        // ========== UTILITY FUNCTIONS ==========
        // fetchJSON - Consolidated fetch utility with error handling and timeout
        // Returns parsed JSON response or null if fetch fails
        async function fetchJSON(url, options = {}) {
            const { timeout = 10000, ...fetchOptions } = options;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            try {
                const res = await fetch(url, {
                    ...fetchOptions,
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!res.ok) {
                    console.warn(`fetchJSON: ${url} returned ${res.status}`);
                    return null;
                }

                return await res.json();
            } catch (e) {
                if (e.name === 'AbortError') {
                    console.warn(`fetchJSON: ${url} timed out after ${timeout}ms`);
                } else {
                    console.warn(`fetchJSON: ${url} failed:`, e);
                }
                return null;
            }
        }

        // Fetch auth status on page load and periodically
        async function fetchAuthStatus() {
            const data = await fetchJSON('/auth-status');
            if (data) {
                AUTH_STATE.enabled = data.enabled;
                AUTH_STATE.tokensConfigured = data.tokensConfigured;
                AUTH_STATE.tokensRequired = data.tokensRequired;
                AUTH_STATE.authenticated = data.authenticated;
                updateAuthUI();
            }
        }

        // Update auth-related UI elements
        function updateAuthUI() {
            // Update auth badge in header
            const authBadge = document.getElementById('authBadge');
            if (authBadge) {
                if (!AUTH_STATE.enabled) {
                    authBadge.className = 'auth-badge disabled';
                    authBadge.textContent = 'Auth Disabled';
                    authBadge.title = 'Admin authentication is not enabled';
                } else if (AUTH_STATE.authenticated) {
                    authBadge.className = 'auth-badge authenticated';
                    authBadge.textContent = 'Admin Unlocked';
                    authBadge.title = 'You have admin access';
                } else if (AUTH_STATE.tokensRequired) {
                    authBadge.className = 'auth-badge required';
                    authBadge.textContent = 'Read-Only';
                    authBadge.title = 'Admin features locked - authenticate to unlock';
                } else {
                    authBadge.className = 'auth-badge open';
                    authBadge.textContent = 'Open Access';
                    authBadge.title = 'No tokens configured - all features accessible';
                }
            }

            // Update admin control buttons disabled state
            const adminControls = document.querySelectorAll('[data-admin="true"]');
            const shouldDisable = AUTH_STATE.enabled && AUTH_STATE.tokensRequired && !AUTH_STATE.authenticated;
            adminControls.forEach(el => {
                el.disabled = shouldDisable;
                if (shouldDisable) {
                    el.dataset.locked = 'true';
                } else {
                    delete el.dataset.locked;
                }
            });

            // Show/hide login button
            const loginBtn = document.getElementById('loginBtn');
            const logoutBtn = document.getElementById('logoutBtn');
            if (loginBtn) loginBtn.style.display = AUTH_STATE.tokensRequired && !AUTH_STATE.authenticated ? 'inline-flex' : 'none';
            if (logoutBtn) logoutBtn.style.display = AUTH_STATE.authenticated ? 'inline-flex' : 'none';
        }

        // Wrapper for admin fetch calls that adds auth token
        async function adminFetch(url, options = {}) {
            const opts = { ...options };
            if (!opts.headers) opts.headers = {};

            // Add auth token if authenticated
            if (AUTH_STATE.token) {
                opts.headers['x-admin-token'] = AUTH_STATE.token;
            }

            const res = await fetch(url, opts);

            // If we get 401, we might have been logged out
            if (res.status === 401) {
                AUTH_STATE.authenticated = false;
                AUTH_STATE.token = null;
                sessionStorage.removeItem('adminToken');
                updateAuthUI();
                showToast('Admin session expired', 'warning');
            }

            return res;
        }

        // Show login dialog
        function showLoginDialog() {
            const token = prompt('Enter admin token:');
            if (token === null) return;  // Cancelled

            if (!token || token.length < 1) {
                showToast('Token cannot be empty', 'error');
                return;
            }

            // Try to authenticate by checking auth-status with the token
            fetch('/auth-status', {
                headers: { 'x-admin-token': token }
            })
            .then(res => res.json())
            .then(data => {
                if (data.authenticated) {
                    AUTH_STATE.token = token;
                    AUTH_STATE.authenticated = true;
                    // Store in sessionStorage (cleared on browser close)
                    sessionStorage.setItem('adminToken', token);
                    // Optionally store in localStorage if "remember" is checked
                    if (document.getElementById('rememberToken')?.checked) {
                        localStorage.setItem('adminToken', token);
                    }
                    updateAuthUI();
                    showToast('Admin access granted', 'success');
                    // Refresh data to show admin features
                    fetchStats();
                } else {
                    showToast('Invalid admin token', 'error');
                }
            })
            .catch(() => {
                showToast('Authentication failed', 'error');
            });
        }

        // Logout
        function logout() {
            AUTH_STATE.token = null;
            AUTH_STATE.authenticated = false;
            sessionStorage.removeItem('adminToken');
            localStorage.removeItem('adminToken');
            updateAuthUI();
            showToast('Logged out', 'info');
        }

        // Check for stored token on load
        function loadStoredToken() {
            // Check sessionStorage first (current session)
            let token = sessionStorage.getItem('adminToken');
            // Fall back to localStorage (persisted)
            if (!token) {
                token = localStorage.getItem('adminToken');
            }
            if (token) {
                // Verify token is still valid
                fetch('/auth-status', {
                    headers: { 'x-admin-token': token }
                })
                .then(res => res.json())
                .then(data => {
                    if (data.authenticated) {
                        AUTH_STATE.token = token;
                        AUTH_STATE.authenticated = true;
                        updateAuthUI();
                    } else {
                        // Token no longer valid, clear it
                        sessionStorage.removeItem('adminToken');
                        localStorage.removeItem('adminToken');
                    }
                })
                .catch(() => {
                    // Silent fail - auth status check failed
                });
            }
        }

        // Initialize charts
        function initCharts() {
            const chartOptions = {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255,255,255,0.1)' },
                        ticks: { color: '#aaa', maxTicksLimit: 8 }
                    },
                    y: {
                        grid: { color: 'rgba(255,255,255,0.1)' },
                        ticks: { color: '#aaa' },
                        beginAtZero: true
                    }
                }
            };

            // Initialize charts only if Chart.js is available
            if (FEATURES.chartJs) {
            requestChart = new Chart(document.getElementById('requestChart'), {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        borderColor: '#06b6d4',
                        backgroundColor: 'rgba(6, 182, 212, 0.1)',
                        fill: true,
                        tension: 0.3
                    }]
                },
                options: chartOptions
            });
            STATE.charts.request = requestChart;

            latencyChart = new Chart(document.getElementById('latencyChart'), {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        borderColor: '#22c55e',
                        backgroundColor: 'rgba(34, 197, 94, 0.1)',
                        fill: true,
                        tension: 0.3
                    }]
                },
                options: chartOptions
            });
            STATE.charts.latency = latencyChart;

            // Error rate chart
            errorChart = new Chart(document.getElementById('errorChart'), {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        fill: true,
                        tension: 0.3
                    }]
                },
                options: {
                    ...chartOptions,
                    scales: {
                        ...chartOptions.scales,
                        y: {
                            ...chartOptions.scales.y,
                            max: 100,
                            ticks: {
                                color: '#aaa',
                                callback: value => value + '%'
                            }
                        }
                    }
                }
            });
            STATE.charts.error = errorChart;

            // Request distribution pie chart
            distChart = new Chart(document.getElementById('distChart'), {
                type: 'doughnut',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        backgroundColor: [
                            '#06b6d4', '#8b5cf6', '#22c55e', '#f59e0b',
                            '#ef4444', '#ec4899', '#6366f1', '#14b8a6'
                        ]
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'right',
                            labels: { color: '#aaa', font: { size: 11 } }
                        }
                    }
                }
            });
            STATE.charts.dist = distChart;

            // Routing Observability Charts
            routingTierChart = new Chart(document.getElementById('routingTierChart'), {
                type: 'doughnut',
                data: {
                    labels: ['Light', 'Medium', 'Heavy'],
                    datasets: [{
                        data: [0, 0, 0],
                        backgroundColor: ['#06b6d4', '#f59e0b', '#ef4444']
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'right',
                            labels: { color: '#aaa', font: { size: 10 } }
                        }
                    }
                }
            });

            routingSourceChart = new Chart(document.getElementById('routingSourceChart'), {
                type: 'doughnut',
                data: {
                    labels: ['Override', 'Rule', 'Classifier', 'Default', 'Failover'],
                    datasets: [{
                        data: [0, 0, 0, 0, 0],
                        backgroundColor: ['#8b5cf6', '#06b6d4', '#22c55e', '#64748b', '#ef4444']
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'right',
                            labels: { color: '#aaa', font: { size: 10 } }
                        }
                    }
                }
            });

            routing429Chart = new Chart(document.getElementById('routing429Chart'), {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: '429s',
                            data: [],
                            borderColor: '#ef4444',
                            backgroundColor: 'rgba(239, 68, 68, 0.1)',
                            fill: true,
                            tension: 0.3
                        },
                        {
                            label: 'Burst Dampened',
                            data: [],
                            borderColor: '#f59e0b',
                            backgroundColor: 'rgba(245, 158, 11, 0.1)',
                            fill: true,
                            tension: 0.3
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top',
                            labels: { color: '#aaa', font: { size: 10 } }
                        }
                    },
                    scales: {
                        x: {
                            grid: { color: 'rgba(255,255,255,0.1)' },
                            ticks: { color: '#aaa', maxTicksLimit: 8 }
                        },
                        y: {
                            grid: { color: 'rgba(255,255,255,0.1)' },
                            ticks: { color: '#aaa' },
                            beginAtZero: true
                        }
                    }
                }
            });
            STATE.charts.routing429 = routing429Chart;
            } else {
                console.warn('Chart.js not available - charts will show degraded tabular data');
            }
        }

        // ========== THEME TOGGLE ==========
        // SVG icon strings for client-side theme toggling
        const SVG_ICON_SUN = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
        const SVG_ICON_MOON = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

        function toggleTheme() {
            const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            STATE.settings.theme = newTheme;
            document.getElementById('themeIcon').innerHTML = newTheme === 'dark' ? SVG_ICON_SUN : SVG_ICON_MOON;
            localStorage.setItem('dashboard-theme', newTheme);

            // Update chart colors
            updateChartColors(newTheme);
            showToast(`Theme changed to ${newTheme}`, 'success');
        }

        function updateChartColors(theme) {
            const gridColor = theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
            const tickColor = theme === 'dark' ? '#aaa' : '#666';

            [requestChart, latencyChart, errorChart].forEach(chart => {
                if (chart) {
                    chart.options.scales.x.grid.color = gridColor;
                    chart.options.scales.y.grid.color = gridColor;
                    chart.options.scales.x.ticks.color = tickColor;
                    chart.options.scales.y.ticks.color = tickColor;
                    chart.update('none');
                }
            });
        }

        function loadTheme() {
            const savedTheme = localStorage.getItem('dashboard-theme') || 'dark';
            if (savedTheme !== 'dark') {
                document.documentElement.setAttribute('data-theme', savedTheme);
                STATE.settings.theme = savedTheme;
                document.getElementById('themeIcon').innerHTML = savedTheme === 'dark' ? SVG_ICON_SUN : SVG_ICON_MOON;
            }
        }

        // ========== DENSITY TOGGLE ==========
        function setDensity(density) {
            STATE.settings.density = density;

            // Update body class
            document.body.classList.remove('density-compact', 'density-comfortable', 'density-spacious');
            document.body.classList.add(`density-${density}`);

            // Update active button
            document.querySelectorAll('.density-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.density === density);
            });

            // Save to localStorage
            localStorage.setItem('dashboard-density', density);

            showToast(`Density set to ${density}`, 'info');
        }

        function loadDensity() {
            const savedDensity = localStorage.getItem('dashboard-density') || 'comfortable';
            setDensity(savedDensity);
        }

        // ========== TAB ORDERING CONFIGURATION (Phase 2) ==========
        // Default ordering for each tab: 'desc' = newest at top, 'asc' = newest at bottom
        const DEFAULT_TAB_ORDERING = {
            live: 'desc',      // Newest at top (feed style)
            traces: 'desc',    // Newest at top (feed style)
            logs: 'asc',       // Newest at bottom (console style)
            circuit: 'desc'    // Newest at top (timeline style)
        };

        const ORDERING_LABELS = {
            desc: 'Newest at top ↓',
            asc: 'Newest at bottom ↓'
        };

        function safeParseJson(str, fallback) {
            if (!str) return fallback;
            try { return JSON.parse(str); } catch (e) { return fallback; }
        }

        // Get ordering preference for a tab
        function getTabOrdering(tabId) {
            const config = safeParseJson(localStorage.getItem('dashboard-tab-ordering'), { ...DEFAULT_TAB_ORDERING });
            return config[tabId] || DEFAULT_TAB_ORDERING[tabId];
        }

        // Set ordering preference for a tab
        function setTabOrdering(tabId, direction) {
            const config = safeParseJson(localStorage.getItem('dashboard-tab-ordering'), { ...DEFAULT_TAB_ORDERING });
            config[tabId] = direction;
            localStorage.setItem('dashboard-tab-ordering', JSON.stringify(config));
            STATE.settings.tabOrdering = config;

            // Update the visual indicator for this tab
            updateOrderingIndicator(tabId, direction);

            // Re-render the tab content with new ordering
            refreshTabContent(tabId);

            showToast(`${capitalize(tabId)} ordering: ${ORDERING_LABELS[direction]}`, 'info');
        }

        // Toggle ordering for current tab
        function toggleTabOrdering(tabId) {
            const current = getTabOrdering(tabId);
            const newOrdering = current === 'desc' ? 'asc' : 'desc';
            setTabOrdering(tabId, newOrdering);
        }

        // Update the visual badge for a tab
        function updateOrderingIndicator(tabId, direction) {
            const badge = document.querySelector(`#tab-${tabId} .ordering-indicator`);
            if (!badge) return;

            // Remove both classes
            badge.classList.remove('ordering-newest-top', 'ordering-newest-bottom');

            // Add appropriate class and text
            if (direction === 'desc') {
                badge.classList.add('ordering-newest-top');
                badge.textContent = 'Newest at top ↓';
                badge.title = 'Click to reverse. Current: newest at top';
                badge.setAttribute('aria-pressed', 'true');
            } else {
                badge.classList.add('ordering-newest-bottom');
                badge.textContent = 'Newest at bottom ↓';
                badge.title = 'Click to reverse. Current: newest at bottom';
                badge.setAttribute('aria-pressed', 'false');
            }

            // Add auto-scroll dot for logs tab if it's at bottom (default behavior)
            if (tabId === 'logs' && direction === 'asc') {
                const dot = document.createElement('span');
                dot.className = 'autoscroll-dot';
                badge.appendChild(dot);
            }
        }

        // Load ordering preferences on startup
        function loadTabOrdering() {
            const config = safeParseJson(localStorage.getItem('dashboard-tab-ordering'), { ...DEFAULT_TAB_ORDERING });
            STATE.settings.tabOrdering = config;

            // Update all tab indicators
            Object.keys(config).forEach(tabId => {
                updateOrderingIndicator(tabId, config[tabId]);
            });
        }

        // Refresh tab content with current ordering
        function refreshTabContent(tabId) {
            switch (tabId) {
                case 'live': {
                    const vp = document.querySelector('.virtual-scroll-viewport');
                    if (vp) vp.scrollTop = 0;
                    scheduleVirtualRender();
                    break;
                }
                case 'traces':
                    if (typeof updateTracesTable === 'function') {
                        updateTracesTable();
                    }
                    break;
                case 'logs':
                    // Logs will auto-refresh on next update
                    break;
                case 'circuit':
                    if (typeof updateCircuitTimeline === 'function') {
                        updateCircuitTimeline();
                    }
                    break;
            }
        }

        // Helper function
        function capitalize(str) {
            return str.charAt(0).toUpperCase() + str.slice(1);
        }

        // ========== TIME RANGE SELECTOR ==========
        let timeRangeChangeTimeout = null;

        function setTimeRange(range, updateUrl = true) {
            // Validate range against TIME_RANGES
            if (!VALID_RANGES.includes(range)) {
                range = '1h'; // Default to 1h if invalid
            }

            STATE.settings.timeRange = range;

            // Update active button immediately for visual feedback
            document.querySelectorAll('.time-range-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.range === range);
            });

            // Update chart labels using TIME_RANGES
            const label = TIME_RANGES[range].label;
            document.getElementById('chartTimeLabel').textContent = label;
            document.getElementById('chartTimeLabel2').textContent = label;
            document.getElementById('chartTimeLabel3').textContent = label;

            // Sync to URL for persistence
            if (updateUrl) {
                const url = new URL(window.location);
                url.searchParams.set('range', range);
                window.history.replaceState({}, '', url);
            }

            // Clear any pending timeout
            if (timeRangeChangeTimeout) {
                clearTimeout(timeRangeChangeTimeout);
            }

            // Debounce the interval reset and fetch to avoid rapid-fire requests
            timeRangeChangeTimeout = setTimeout(() => {
                // Adjust poll interval based on range (longer ranges poll less frequently)
                if (historyIntervalId) {
                    clearInterval(historyIntervalId);
                }
                historyIntervalId = setInterval(fetchHistory, TIME_RANGES[range].pollInterval);

                // Abort any pending fetch and fetch new history immediately
                if (historyFetchController) {
                    historyFetchController.abort();
                    historyFetchController = null;
                }
                fetchHistory();
            }, 100); // 100ms debounce to prevent rapid-fire requests

            showToast(`Time range set to ${range}`, 'info');
        }

        // Initialize time range from URL
        function initTimeRangeFromUrl() {
            const urlParams = new URLSearchParams(window.location.search);
            const range = urlParams.get('range');
            if (range && VALID_RANGES.includes(range)) {
                setTimeRange(range, false);
            }
        }

        // ========== ERROR BOUNDARY (Phase 4) ==========
        class ErrorBoundary {
            constructor() {
                this.lastErrors = new Map();
                this.dedupeWindow = TOAST_DISPLAY_DURATION;
            }

            run(component, fn) {
                try {
                    return fn();
                } catch (error) {
                    this.handleError(error, component);
                }
            }

            async runAsync(component, fn) {
                try {
                    return await fn();
                } catch (error) {
                    this.handleError(error, component);
                }
            }

            handleError(error, component) {
                const message = error.message || 'Unknown error';
                const now = Date.now();
                const lastTime = this.lastErrors.get(`${component}:${message}`);

                if (lastTime && now - lastTime < this.dedupeWindow) {
                    return;
                }

                this.lastErrors.set(`${component}:${message}`, now);

                // Filter benign errors
                if (this.isBenign(error)) {
                    console.warn('[ErrorBoundary] Benign error filtered:', error);
                    return;
                }

                // Show toast
                if (typeof showToast === 'function') {
                    showToast(message.slice(0, 100), 'error');
                }

                if (window.__DASHBOARD_DEBUG__) {
                    window.__DASHBOARD_DEBUG__.errors.toastsShown++;
                    window.__DASHBOARD_DEBUG__.errors.lastToast = message;
                }

                console.error('[ErrorBoundary]', component, error);
            }

            isBenign(error) {
                const benign = ['AbortError', 'Chart.js', 'ResizeObserver', 'Script error'];
                return benign.some(pattern =>
                    error.message?.includes(pattern) || error.name?.includes(pattern)
                );
            }
        }

        const errorBoundary = new ErrorBoundary();

        // Expose utilities for testing when debug mode is enabled
        if (debugEnabled) {
            window.errorBoundary = errorBoundary;
            window.withLoading = withLoading;
            window.escapeRegex = escapeRegex;
            window.debounce = debounce;
        }

        // ========== TOAST NOTIFICATIONS ==========
        // Use utility from dashboard-utils.js
        const showToast = window.DashboardUtils?.showToast || function(message, type = 'info', duration = TOAST_DISPLAY_DURATION) {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            toast.setAttribute('role', 'alert');
            toast.setAttribute('aria-live', 'polite');

            const icons = {
                success: '✓',
                error: '!',
                warning: '⚠',
                info: 'i'
            };

            // Add progress bar for auto-dismiss indicator
            const progressDuration = Math.min(duration, 4000);

            toast.innerHTML = '<div class="toast-icon">' + (icons[type] || icons.info) + '</div>' +
                '<div class="toast-message">' + escapeHtml(message) + '</div>' +
                '<button class="toast-close" data-action="close-toast" aria-label="Close notification">×</button>' +
                '<div class="toast-progress" style="animation-duration: ' + (progressDuration) + 'ms"></div>';

            container.appendChild(toast);

            setTimeout(() => {
                toast.classList.add('removing');
                setTimeout(() => toast.remove(), TOAST_ANIMATION_DURATION);
            }, duration);
        };

        // ========== KEYBOARD SHORTCUTS ==========

        // ========== KEYBOARD SHORTCUTS ==========
        function showShortcutsModal() {
            document.getElementById('shortcutsModal').classList.add('visible');
        }

        function closeShortcutsModal(e) {
            if (e.target.id === 'shortcutsModal' || e.key === 'Escape') {
                document.getElementById('shortcutsModal').classList.remove('visible');
            }
        }

        function handleKeyboardShortcuts(e) {
            // Ignore if typing in input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            // Arrow key navigation for tablists (a11y)
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                const tablist = document.activeElement ? document.activeElement.closest('[role="tablist"]') : null;
                if (tablist) {
                    e.preventDefault();
                    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
                    const currentIdx = tabs.indexOf(document.activeElement);
                    if (currentIdx === -1) return;
                    let nextIdx;
                    if (e.key === 'ArrowRight') {
                        nextIdx = (currentIdx + 1) % tabs.length;
                    } else {
                        nextIdx = (currentIdx - 1 + tabs.length) % tabs.length;
                    }
                    tabs[nextIdx].focus();
                    tabs[nextIdx].click();
                    return;
                }
            }

            const key = e.key.toLowerCase();

            // Dock tab shortcuts (1-2) - switch to Requests page sub-tabs
            if (key >= '1' && key <= '2') {
                if (STATE.activePage === 'requests') {
                    e.preventDefault();
                    const reqTabs = ['live', 'traces'];
                    const tabIndex = parseInt(key) - 1;
                    if (reqTabs[tabIndex]) {
                        switchRequestTab(reqTabs[tabIndex]);
                    }
                    return;
                }
            }

            // Density cycling (C or Shift+C)
            if (e.key === 'C') {
                e.preventDefault();
                const currentIndex = STATE.densityOptions.indexOf(STATE.settings.density);
                const nextIndex = (currentIndex + 1) % STATE.densityOptions.length;
                setDensity(STATE.densityOptions[nextIndex]);
                showToast(`Density: ${STATE.densityOptions[nextIndex]}`, 'info');
                return;
            }

            switch(key) {
                case 'j':
                    // Navigate down in request list
                    e.preventDefault();
                    navigateRequestList(1);
                    break;
                case 'k':
                    // Navigate up in request list
                    e.preventDefault();
                    navigateRequestList(-1);
                    break;
                case 'enter':
                    // Open selected request in side panel
                    if (STATE.selectedListIndex >= 0) {
                        e.preventDefault();
                        const rows = document.querySelectorAll('#liveStreamRequestList .request-row');
                        if (rows[STATE.selectedListIndex]) {
                            const requestId = rows[STATE.selectedListIndex].dataset.requestId;
                            if (requestId) openSidePanel(requestId);
                        }
                    }
                    break;
                case 'p':
                    controlAction(STATE.settings.paused ? 'resume' : 'pause');
                    break;
                case 'r':
                    if (!e.ctrlKey && !e.metaKey) {
                        e.preventDefault();
                        fetchStats();
                        showToast('Data refreshed', 'info');
                    }
                    break;
                case 'd':
                    e.preventDefault();
                    toggleTheme();
                    break;
                case 'e':
                    e.preventDefault();
                    exportData();
                    break;
                case 'f':
                    e.preventDefault();
                    // Toggle fullscreen for focused chart or first chart
                    const focusedChart = document.activeElement.closest('.chart-card');
                    if (focusedChart) {
                        const container = focusedChart.querySelector('.chart-container');
                        if (container) toggleFullscreen(container.id);
                    }
                    break;
                case 'l':
                    e.preventDefault();
                    // Phase 4c: Navigate to Requests page > Live Stream sub-tab
                    switchPage('requests');
                    switchRequestTab('live');
                    break;
                case '?':
                    e.preventDefault();
                    showShortcutsModal();
                    break;
                case 'escape':
                    // Close side panel first if open (Milestone D)
                    if (STATE.selectedRequestId) {
                        closeSidePanel();
                        return;
                    }
                    document.querySelectorAll('.chart-container.fullscreen').forEach(el => {
                        el.classList.remove('fullscreen');
                    });
                    closeShortcutsModal({ target: { id: 'shortcutsModal' }, key: 'Escape' });
                    break;
            }
        }

        // ========== REQUEST LIST NAVIGATION (Week 2 UX) ==========
        STATE.selectedListIndex = -1;
        STATE.filters = { status: '', key: '', model: '' };

        function navigateRequestList(direction) {
            const rows = document.querySelectorAll('#liveStreamRequestList .request-row');
            if (rows.length === 0) return;

            // Remove previous selection
            rows.forEach(r => r.classList.remove('selected'));

            // Calculate new index
            STATE.selectedListIndex += direction;
            if (STATE.selectedListIndex < 0) STATE.selectedListIndex = 0;
            if (STATE.selectedListIndex >= rows.length) STATE.selectedListIndex = rows.length - 1;

            // Add selection
            const selectedRow = rows[STATE.selectedListIndex];
            if (selectedRow) {
                selectedRow.classList.add('selected');
                selectedRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }

        function clearRequestListSelection() {
            STATE.selectedListIndex = -1;
            document.querySelectorAll('#liveStreamRequestList .request-row.selected').forEach(r => r.classList.remove('selected'));
        }

        // ========== FILTER LOGIC (Week 2 UX) ==========
        function applyFilters() {
            const statusFilter = document.getElementById('filterStatus')?.value || '';
            const keyFilter = document.getElementById('filterKey')?.value || '';
            const modelFilter = document.getElementById('filterModel')?.value || '';

            STATE.filters = { status: statusFilter, key: keyFilter, model: modelFilter };

            // Reset scroll position so virtual render starts from the top
            const viewport = document.querySelector('.virtual-scroll-viewport');
            if (viewport) viewport.scrollTop = 0;

            const rows = document.querySelectorAll('#liveStreamRequestList .request-row');
            let visibleCount = 0;

            rows.forEach(row => {
                const status = row.dataset.status || '';
                const key = row.dataset.keyIndex || '';
                const model = row.dataset.model || '';

                const matchesStatus = !statusFilter || status === statusFilter;
                const matchesKey = !keyFilter || key === keyFilter;
                const matchesModel = !modelFilter || model.includes(modelFilter);

                if (matchesStatus && matchesKey && matchesModel) {
                    row.style.display = '';
                    visibleCount++;
                } else {
                    row.style.display = 'none';
                }
            });

            // Update filter count
            const filterCountEl = document.getElementById('filterCount');
            if (filterCountEl) {
                if (statusFilter || keyFilter || modelFilter) {
                    filterCountEl.textContent = `Showing ${visibleCount} of ${rows.length} requests`;
                } else {
                    filterCountEl.textContent = 'Showing all requests';
                }
            }

            clearRequestListSelection();
            scheduleVirtualRender();
        }

        function clearFilters() {
            document.getElementById('filterStatus').value = '';
            document.getElementById('filterKey').value = '';
            document.getElementById('filterModel').value = '';
            STATE.filters = { status: '', key: '', model: '' };
            applyFilters();
            showToast('Filters cleared', 'info');
        }

        function populateFilterOptions() {
            // Populate key filter from available keys
            const keySelect = document.getElementById('filterKey');
            if (keySelect && STATE.keys.data) {
                const currentValue = keySelect.value;
                keySelect.innerHTML = '<option value="">All Keys</option>';
                STATE.keys.data.forEach((key, index) => {
                    const option = document.createElement('option');
                    option.value = index.toString();
                    option.textContent = `Key ${index}`;
                    keySelect.appendChild(option);
                });
                keySelect.value = currentValue;
            }

            // Populate model filter - will use dynamic models if available
            populateModelFilter();
        }

        // Populate model filter dropdown with dynamic models from /models endpoint
        function populateModelFilter() {
            const modelSelect = document.getElementById('filterModel');
            if (!modelSelect) return;

            const currentValue = modelSelect.value;
            const models = new Set();

            // Use dynamic models from /models endpoint if available
            if (STATE.models && STATE.models.length > 0) {
                STATE.models.forEach(model => models.add(model));
            }

            // Also include mapped (GLM) models from request history
            STATE.requestsHistory.forEach(r => {
                if (r.mappedModel) models.add(r.mappedModel);
            });

            modelSelect.innerHTML = '<option value="">All Models</option>';
            [...models].sort().forEach(modelId => {
                const option = document.createElement('option');
                option.value = modelId;
                // Use display name from modelsData if available, otherwise use ID
                const modelData = STATE.modelsData && STATE.modelsData[modelId];
                const displayName = modelData && modelData.displayName ? modelData.displayName : modelId;
                const tier = modelData && modelData.tier ? ' [' + modelData.tier + ']' : '';
                option.textContent = displayName + tier;
                if (displayName.length > 30) {
                    option.textContent = displayName.slice(0, 30) + '...' + tier;
                }
                modelSelect.appendChild(option);
            });
            modelSelect.value = currentValue;
        }

        // ========== MODEL SELECTION HELPERS ==========
        // Helper function to create a model select dropdown element
        function createModelSelectElement(options = {}) {
            const {
                id = 'modelSelect',
                className = 'filter-select',
                placeholder = 'Select a model',
                includeAllOption = true,
                selectedValue = ''
            } = options;

            const select = document.createElement('select');
            select.id = id;
            select.className = className;

            if (includeAllOption) {
                const allOption = document.createElement('option');
                allOption.value = '';
                allOption.textContent = placeholder || 'All Models';
                select.appendChild(allOption);
            }

            // Add models from STATE.models
            const models = new Set();
            if (STATE.models && STATE.models.length > 0) {
                STATE.models.forEach(model => models.add(model));
            }

            // Also include mapped (GLM) models from request history
            STATE.requestsHistory.forEach(r => {
                if (r.mappedModel) models.add(r.mappedModel);
            });

            [...models].sort().forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                if (selectedValue && model === selectedValue) {
                    option.selected = true;
                }
                select.appendChild(option);
            });

            return select;
        }

        // Helper to get model list as array (GLM models only)
        function getAvailableModels() {
            const models = new Set();

            if (STATE.models && STATE.models.length > 0) {
                STATE.models.forEach(model => models.add(model));
            }

            return [...models].sort();
        }

        // ========== AUTO-SCROLL TOGGLE (Week 2 UX) ==========
        function toggleAutoScroll() {
            STATE.settings.autoScroll = !STATE.settings.autoScroll;
            const btn = document.getElementById('autoScrollToggle');
            if (btn) {
                btn.classList.toggle('active', STATE.settings.autoScroll);
                btn.title = `Toggle auto-scroll (${STATE.settings.autoScroll ? 'on' : 'off'})`;
            }
            showToast(`Auto-scroll ${STATE.settings.autoScroll ? 'enabled' : 'disabled'}`, 'info');
        }

        function jumpToLatest() {
            const requestList = document.getElementById('liveStreamRequestList');
            if (requestList) {
                requestList.scrollTop = 0; // Newest at top
                showToast('Jumped to latest', 'info');
            }
        }

        // ========== COPY TO CLIPBOARD (Week 2 UX) ==========
        function copyToClipboard(text, btn) {
            navigator.clipboard.writeText(text).then(() => {
                if (btn) {
                    const originalText = btn.textContent;
                    btn.textContent = '✓';
                    btn.classList.add('copied');
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.classList.remove('copied');
                    }, 1500);
                }
                showToast('Copied to clipboard', 'success');
            }).catch(() => {
                showToast('Failed to copy', 'error');
            });
        }

        // ========== FILTER INITIALIZATION (Week 2 UX) ==========
        function initFilterListeners() {
            // Listen for filter select changes
            const filterStatus = document.getElementById('filterStatus');
            const filterKey = document.getElementById('filterKey');
            const filterModel = document.getElementById('filterModel');
            const tenantSelect = document.getElementById('tenantSelect');

            if (filterStatus) filterStatus.addEventListener('change', applyFilters);
            if (filterKey) filterKey.addEventListener('change', applyFilters);
            if (filterModel) filterModel.addEventListener('change', applyFilters);
            if (tenantSelect) tenantSelect.addEventListener('change', function(e) {
                selectTenant(e.target.value);
            });

            // Initialize auto-scroll button state
            const autoScrollBtn = document.getElementById('autoScrollToggle');
            if (autoScrollBtn) {
                autoScrollBtn.classList.toggle('active', STATE.settings.autoScroll !== false);
            }

            // Populate filter options after a delay (wait for data to load)
            setTimeout(populateFilterOptions, 2000);
        }

        // ========== FULLSCREEN CHARTS ==========
        function toggleFullscreen(containerId) {
            const container = document.getElementById(containerId);
            if (container) {
                container.classList.toggle('fullscreen');
                if (container.classList.contains('fullscreen')) {
                    document.addEventListener('keydown', function escHandler(e) {
                        if (e.key === 'Escape') {
                            container.classList.remove('fullscreen');
                            document.removeEventListener('keydown', escHandler);
                        }
                    });
                }
            }
        }

        // ========== ANIMATED NUMBERS ==========
        function animateNumber(elementId, newValue, suffix = '', duration = 600) {
            const element = document.getElementById(elementId);
            if (!element) return;

            const currentValue = parseFloat(element.textContent) || 0;
            if (currentValue === newValue) return;

            // Cancel existing transition
            if (numberTransitions.has(elementId)) {
                cancelAnimationFrame(numberTransitions.get(elementId));
            }

            const startTime = performance.now();
            const startValue = currentValue;
            const change = newValue - startValue;

            function update(currentTime) {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);

                // Ease out cubic
                const eased = 1 - Math.pow(1 - progress, 3);
                const current = startValue + change * eased;

                // Format based on value type
                if (Number.isInteger(newValue)) {
                    element.textContent = Math.round(current) + suffix;
                } else if (suffix === '%') {
                    element.textContent = current.toFixed(1) + suffix;
                } else {
                    element.textContent = current.toFixed(0) + suffix;
                }

                if (progress < 1) {
                    numberTransitions.set(elementId, requestAnimationFrame(update));
                } else {
                    numberTransitions.delete(elementId);
                }
            }

            numberTransitions.set(elementId, requestAnimationFrame(update));
        }

        // ========== DATA EXPORT ==========
        async function exportData() {
            try {
                const statsRes = await fetch('/stats');
                const stats = await statsRes.json();

                const historyRes = await fetch('/history?minutes=' + TIME_RANGES[STATE.settings.timeRange].minutes, { cache: 'no-store' });
                const history = await historyRes.json();

                // Create CSV content
                const csvContent = generateCSV(stats, history);

                // Create JSON content
                const jsonContent = JSON.stringify({ stats, history }, null, 2);

                // Download both
                downloadFile(csvContent, 'glm-proxy-stats.csv', 'text/csv');
                setTimeout(() => {
                    downloadFile(jsonContent, 'glm-proxy-stats.json', 'application/json');
                }, 100);

                showToast('Data exported successfully', 'success');
            } catch (err) {
                console.error('Export failed:', err);
                showToast('Export failed: ' + err.message, 'error');
            }
        }

        // Share URL function (UX #9)
        async function shareURL() {
            try {
                const url = window.location.href;
                await navigator.clipboard.writeText(url);

                // Update button to show copied state
                const btn = document.getElementById('shareUrlBtn');
                const text = document.getElementById('shareUrlText');
                if (btn && text) {
                    btn.classList.add('copied');
                    text.textContent = 'Copied!';

                    setTimeout(() => {
                        btn.classList.remove('copied');
                        text.textContent = 'Share';
                    }, 2000);
                }

                showToast('URL copied to clipboard', 'success');
            } catch (err) {
                console.error('Copy failed:', err);
                showToast('Failed to copy URL', 'error');
            }
        }

        function generateCSV(stats, history) {
            const lines = [];

            // Summary stats
            lines.push('Metric,Value');
            lines.push('Uptime,' + (stats.uptimeFormatted || ''));
            lines.push('Total Requests,' + (stats.clientRequests?.total || 0));
            lines.push('Success Rate,' + (stats.successRate || 0) + '%');
            lines.push('Avg Latency,' + (stats.latency?.avg || 0) + 'ms');
            lines.push('');

            // Key stats
            lines.push('Key,State,Total Requests,Success Rate,Avg Latency');
            if (stats.keys) {
                stats.keys.forEach(k => {
                    lines.push('K' + k.index + ',' + k.state + ',' + (k.total || 0) + ',' + (k.successRate || 0) + '%,' + (k.latency?.avg || 0) + 'ms');
                });
            }
            lines.push('');

            // Error breakdown
            lines.push('Error Type,Count');
            if (stats.errors) {
                Object.entries(stats.errors).forEach(([type, count]) => {
                    if (typeof count === 'number' && count > 0 && type !== 'totalRetries' && type !== 'retriesSucceeded') {
                        lines.push(type + ',' + count);
                    }
                });
            }

            return lines.join('\n');
        }

        function downloadFile(content, filename, mimeType) {
            const blob = new Blob([content], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        // ========== LIVE REQUEST STREAM (SSE) ==========
        function connectRequestStream() {
            if (STATE.sse.eventSource) {
                STATE.sse.eventSource.close();
            }

            try {
                STATE.sse.eventSource = new EventSource('/requests/stream');

                STATE.sse.eventSource.onopen = () => {
                    STATE.sse.connected = true;
                    updateConnectionStatus('connected');
                    // Dispatch connected action with clientId
                    const clientId = 'sse-' + Date.now();
                    store.dispatch(Actions.sseConnected({ clientId, recentRequests: [] }));

                    // Re-attach LiveFlowViz SSE listener after reconnection
                    if (window._liveFlowViz) {
                        window._liveFlowViz._sseAttached = false;
                        window._liveFlowViz._stopFallbackPolling();
                        window._liveFlowViz._attachSSE();
                    }
                };

                STATE.sse.eventSource.onmessage = (e) => {
                    try {
                        const data = JSON.parse(e.data);
                        if (data.type === 'init') {
                            renderInitialRequests(data.requests);
                        } else {
                            addRequestToStream(data);
                        }
                    } catch (err) {
                        console.error('SSE parse error:', err);
                    }
                };

                STATE.sse.eventSource.onerror = () => {
                    STATE.sse.connected = false;
                    updateConnectionStatus('error');
                    // Dispatch disconnected action
                    store.dispatch(Actions.sseDisconnected());

                    // Switch LiveFlowViz to fallback polling on SSE error
                    if (window._liveFlowViz && !window._liveFlowViz._usePolling) {
                        window._liveFlowViz._sseAttached = false;
                        window._liveFlowViz._setStatus('error');
                        window._liveFlowViz._startFallbackPolling();
                    }

                    // Reconnect faster in debug mode (for tests), slower in production
                    const reconnectDelay = debugEnabled ? 500 : 5000;
                    setTimeout(connectRequestStream, reconnectDelay);
                };

            } catch (err) {
                console.error('SSE connection failed:', err);
                // Fallback to polling
                startRequestPolling();
            }
        }

        function renderInitialRequests(requests) {
            const container = document.getElementById('liveStreamRequestList');
            if (!requests || requests.length === 0) {
                container.innerHTML = renderEmptyState('No requests yet', { icon: '—' });
                updateRequestCountBadge(0);  // Milestone B
                return;
            }

            // Merge initial requests with any already-added requests (avoid race conditions)
            // Use a Map to deduplicate by requestId
            const existingById = new Map(STATE.requestsHistory.map(r => [r.requestId || (r.timestamp + '-' + (r.keyIndex ?? 0)), r]));
            for (const req of requests) {
                const id = req.requestId || (req.timestamp + '-' + (req.keyIndex ?? 0));
                if (!existingById.has(id)) {
                    existingById.set(id, req);
                }
            }
            STATE.requestsHistory = Array.from(existingById.values());

            container.innerHTML = requests.map(r => renderRequestRow(r)).join('');
            updateRequestCountBadge(requests.length);  // Milestone B

            // Initialize traces table
            STATE.traces = requests.slice(0, 100).map(r => ({
                timestamp: r.timestamp,
                keyIndex: r.keyIndex,
                path: r.path,
                status: r.error ? 'error' : r.status === 'completed' ? 'success' : 'pending',
                latency: r.latency
            }));
            updateTracesTable(requests[0]); // Trigger table update
        }

        // ========== VIRTUAL SCROLL RENDERER ==========
        const VIRTUAL_ROW_HEIGHT = 28;
        const VIRTUAL_BUFFER = 20;
        let virtualScrollRAF = null;

        function scheduleVirtualRender() {
            if (virtualScrollRAF) return;
            virtualScrollRAF = requestAnimationFrame(function() {
                virtualScrollRAF = null;
                renderVirtualRequestList();
            });
        }

        function renderVirtualRequestList() {
            const viewport = document.querySelector('.virtual-scroll-viewport');
            const container = document.getElementById('liveStreamRequestList');
            if (!viewport || !container) return;

            const items = STATE.requestsHistory;
            const totalItems = items.length;
            if (totalItems === 0) return;

            // Get ordering preference for live tab
            const ordering = getTabOrdering('live');
            const isDescending = ordering === 'desc'; // 'desc' = newest at top

            const viewportHeight = viewport.clientHeight || 400;
            const scrollTop = viewport.scrollTop;

            const visibleCount = Math.ceil(viewportHeight / VIRTUAL_ROW_HEIGHT);
            const startIndex = Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT);
            const bufferedStart = Math.max(0, startIndex - VIRTUAL_BUFFER);
            const endIndex = Math.min(startIndex + visibleCount + VIRTUAL_BUFFER, totalItems);

            // Total scrollable height
            const totalHeight = totalItems * VIRTUAL_ROW_HEIGHT;
            container.style.height = totalHeight + 'px';
            container.style.position = 'relative';

            // Build only visible rows
            const fragment = document.createDocumentFragment();
            for (let displayIdx = bufferedStart; displayIdx < endIndex; displayIdx++) {
                // Calculate array index based on ordering direction
                let arrayIdx;
                if (isDescending) {
                    // Newest-at-top: display index 0 = array index totalItems-1
                    arrayIdx = totalItems - 1 - displayIdx;
                } else {
                    // Newest-at-bottom: display index 0 = array index 0
                    arrayIdx = displayIdx;
                }
                if (arrayIdx < 0 || arrayIdx >= totalItems) break;
                const item = items[arrayIdx];

                const tmp = document.createElement('div');
                tmp.innerHTML = renderRequestRow(item);
                const rowEl = tmp.firstElementChild;
                if (rowEl) {
                    rowEl.style.position = 'absolute';
                    rowEl.style.top = (displayIdx * VIRTUAL_ROW_HEIGHT) + 'px';
                    rowEl.style.left = '0';
                    rowEl.style.right = '0';
                    rowEl.style.height = VIRTUAL_ROW_HEIGHT + 'px';
                    fragment.appendChild(rowEl);
                }
            }

            container.innerHTML = '';
            container.appendChild(fragment);
        }

        // Attach scroll listener after a tick to ensure DOM is ready
        setTimeout(function() {
            const viewport = document.querySelector('.virtual-scroll-viewport');
            if (viewport) {
                viewport.addEventListener('scroll', scheduleVirtualRender, { passive: true });
            }
        }, 0);

        function addRequestToStream(request) {
            // Dispatch to store for state tracking (Milestone D)
            store.dispatch(Actions.requestReceived(request));

            // Update request count badge (Milestone B)
            updateRequestCountBadge(STATE.requestsHistory.length);

            // Schedule virtual re-render
            scheduleVirtualRender();

            // Also update traces table
            updateTracesTable(request);
        }
        if (window.__DASHBOARD_DEBUG__) window.__DASHBOARD_DEBUG__.addRequestToStream = addRequestToStream;

        function renderRequestRow(request) {
            const time = formatTimestamp(request.timestamp);
            const statusClass = request.error ? 'error' : request.status === 'completed' ? 'success' : 'pending';
            const statusText = request.error ? 'ERR' : request.latency ? request.latency + 'ms' : '...';
            // Escape user-influenced path to prevent XSS
            const safePath = escapeHtml(request.path || '/v1/messages');
            // Generate requestId if not present (Milestone D)
            const requestId = request.requestId || (request.timestamp + '-' + (request.keyIndex ?? 0));
            // Filter data attributes (Week 2 UX)
            const model = request.originalModel || request.mappedModel || '';

            // Routing decision chip — two-tone: source model + arrow + target model
            const rd = request.routingDecision;
            const originalDisplay = chipModelName(request.originalModel);
            const mappedDisplay = chipModelName(request.mappedModel);
            const fullTitle = rd
                ? (request.originalModel || '?') + ' → ' + (request.mappedModel || '?') + ' | ' + (rd.reason || '')
                : (request.originalModel || '') + ' → ' + (request.mappedModel || '');
            const chipInner = `<span class="chip-src">${escapeHtml(originalDisplay)}</span><span class="chip-arrow">→</span><span class="chip-dst">${escapeHtml(mappedDisplay)}</span>`;
            const hasChip = !!(rd || request.mappedModel);
            const routingChip = rd
                ? `<span class="routing-chip routing-chip--${escapeHtml(rd.source || 'default')}" title="${escapeHtml(fullTitle)}">${chipInner}</span>`
                : (request.mappedModel ? `<span class="routing-chip routing-chip--legacy" title="${escapeHtml(fullTitle)}">${chipInner}</span>` : '');
            const pathStyle = hasChip ? '' : ' style="grid-column: span 2;"';

            return `
                <div class="request-row" data-action="view-request" data-request-id="${escapeHtml(requestId)}" data-testid="request-row"
                     data-status="${statusClass}" data-key-index="${request.keyIndex ?? ''}" data-model="${escapeHtml(model)}">
                    <span class="request-time">${time}</span>
                    <span class="request-key">K${request.keyIndex ?? '?'}</span>
                    ${routingChip}
                    <span class="request-path"${pathStyle}>${safePath}</span>
                    <span class="request-status ${statusClass}">${statusText}</span>
                </div>
            `;
        }

        // Set up store callback to render requests when dispatched programmatically (for E2E tests)
        // Note: This uses virtual scroll for consistent rendering with SSE requests
        store._onRequestReceived = function(request) {
            // Remove placeholder text if present
            const container = document.getElementById('liveStreamRequestList');
            if (container) {
                const placeholderText = container.textContent || '';
                if (placeholderText.includes('No requests') || placeholderText.includes('Connecting')) {
                    container.innerHTML = '';
                }
            }

            // Let virtual scroll handle all rendering
            scheduleVirtualRender();
            updateRequestCountBadge(STATE.requestsHistory.length);
        };

        function startRequestPolling() {
            // Fallback polling for requests
            requestPollingIntervalId = setInterval(async () => {
                if (STATE.sse.connected) return;
                try {
                    const res = await fetch('/stats');
                    const stats = await res.json();
                    // Could show recent activity here
                } catch (err) {
                    // Ignore
                }
            }, 5000);
        }

        // ========== CONNECTION STATUS ==========
        function updateConnectionStatus(status) {
            STATE.connection.status = status;
            STATE.connection.lastUpdate = Date.now();

            const dot = document.getElementById('connectionDot');
            const text = document.getElementById('connectionText');

            dot.className = 'connection-dot ' + status;
            dot.setAttribute('data-state', status);

            switch(status) {
                case 'connected':
                    text.textContent = 'Connected';
                    text.className = 'connection-text';
                    break;
                case 'error':
                    text.textContent = 'Connection Error';
                    text.className = 'connection-text stale';
                    break;
                case 'stale':
                    text.textContent = 'Stale Data';
                    text.className = 'connection-text stale';
                    break;
            }
        }

        function checkStaleData() {
            if (STATE.connection.lastUpdate && Date.now() - STATE.connection.lastUpdate > 10000) {
                updateConnectionStatus('stale');
                STATE.connection.staleData = true;
            }
        }

        staleCheckIntervalId = setInterval(checkStaleData, 5000);

        // Fetch stats
        // ========== TENANT MANAGEMENT ==========
        let currentTenant = null;
        let tenantsData = null;

        async function fetchTenants() {
            try {
                const res = await fetch('/tenants');
                if (res.ok) {
                    tenantsData = await res.json();
                    updateTenantSelector();
                }
            } catch (err) {
                console.log('Multi-tenant not enabled or error fetching tenants');
            }
        }

        function updateTenantSelector() {
            const select = document.getElementById('tenantSelect');
            const container = document.getElementById('tenantSelectorContainer');

            if (!select || !tenantsData || !tenantsData.enabled) {
                // Hide selector if multi-tenant not enabled
                if (container) container.style.display = 'none';
                return;
            }

            // Show selector
            if (container) container.style.display = 'flex';

            // Clear existing options except "All Tenants"
            while (select.options.length > 1) {
                select.remove(1);
            }

            // Add tenant options
            const tenants = tenantsData.tenants || {};
            for (const tenantId of Object.keys(tenants).sort()) {
                const opt = document.createElement('option');
                opt.value = tenantId;
                opt.textContent = tenantId;
                if (tenantId === currentTenant) opt.selected = true;
                select.appendChild(opt);
            }

            updateTenantInfo();
        }

        function selectTenant(tenantId) {
            currentTenant = tenantId || null;
            updateTenantInfo();
            // Refresh stats with tenant filter
            fetchStats();
        }

        function updateTenantInfo() {
            const infoEl = document.getElementById('tenantKeyCount');
            if (!infoEl || !tenantsData) return;

            if (currentTenant && tenantsData.tenants[currentTenant]) {
                const t = tenantsData.tenants[currentTenant];
                infoEl.textContent = `(${t.keyCount} keys, ${t.requestCount} reqs)`;
            } else {
                infoEl.textContent = `(${tenantsData.tenantCount} tenants)`;
            }
        }

        async function fetchStats() {
            try {
                const statsUrl = currentTenant ? `/stats?tenant=${encodeURIComponent(currentTenant)}` : '/stats';
                const res = await fetch(statsUrl);
                if (!res.ok) {
                    console.error('Stats endpoint returned:', res.status);
                    updateConnectionStatus('error');
                    return;
                }
                const stats = await res.json();
                if (stats) {
                    updateConnectionStatus('connected');
                    STATE.connection.staleData = false;
                    updateUI(stats);
                    updatePoolCooldownKPI(stats);
                }
            } catch (err) {
                console.error('Failed to fetch stats:', err);
                updateConnectionStatus('error');
                // Categorize error for appropriate message
                const category = categorizeError(err);
                const message = getErrorMessage(err, category);
                // Show toast notification for errors
                if (window.DashboardUtils?.showToast) {
                    window.DashboardUtils.showToast(message, 'error');
                }
            }
        }

        // Fetch available models from /models endpoint
        async function fetchModels() {
            const data = await fetchJSON('/models');
            if (data && data.models) {
                // Extract model IDs from model objects (for backward compatibility)
                STATE.models = data.models.map(m => typeof m === 'string' ? m : m.id);
                // Also store full model data for future use (pricing, concurrency, etc.)
                STATE.modelsData = data.models.reduce((acc, m) => {
                    const id = typeof m === 'string' ? m : m.id;
                    acc[id] = typeof m === 'string' ? { id } : m;
                    return acc;
                }, {});
                console.log('Loaded', STATE.models.length, 'available models');
                // Repopulate filter options with new models
                populateModelFilter();
            }
        }

        // Fetch history
        async function fetchHistory() {
            // Skip if an update is already pending (prevent pile-up)
            if (historyUpdatePending) {
                return;
            }

            // Generate unique fetch ID for this request
            const fetchId = ++lastHistoryFetchId;
            historyUpdatePending = true;

            try {
                const range = STATE.settings.timeRange;
                const minutes = TIME_RANGES[range].minutes;

                // Abort any pending fetch
                if (historyFetchController) {
                    historyFetchController.abort();
                }

                // Create new AbortController for this fetch
                historyFetchController = new AbortController();
                const signal = historyFetchController.signal;

                // Check cache with shorter TTL (1s) for better responsiveness
                // Also track last tier to invalidate cache on tier change
                const cacheKey = 'history_v3_' + range;
                const cached = STATE.history.cache[cacheKey];

                // Validate cache: check age AND tier consistency
                const now = Date.now();
                const cacheAge = cached ? now - cached.time : Infinity;
                const tierChanged = STATE.history.lastTier !== cached?.data?.tier;

                if (cached && cacheAge < 1000 && !tierChanged) {
                    updateCharts(cached.data);
                    return;
                }

                const res = await fetch('/history?minutes=' + minutes, {
                    cache: 'no-store',
                    signal: signal
                });

                // Ignore if this request was superseded by a newer one
                if (fetchId !== lastHistoryFetchId) {
                    return;
                }

                if (!res.ok) {
                    console.error('History endpoint returned:', res.status);
                    return;
                }
                const history = await res.json();

                // Ignore if this request was superseded by a newer one
                if (fetchId !== lastHistoryFetchId) {
                    return;
                }

                if (history) {
                    // Validate data integrity before caching
                    if (!validateHistoryData(history, minutes)) {
                        console.warn('History data validation failed, re-fetching...');
                        STATE.history.cache[cacheKey] = null; // Clear invalid cache
                        return;
                    }

                    STATE.history.cache[cacheKey] = { time: now, data: history };
                    STATE.history.lastTier = history.tier;
                    updateCharts(history);
                }
            } catch (err) {
                // Ignore aborted requests (normal when switching time ranges rapidly)
                if (err.name === 'AbortError') {
                    return;
                }
                console.error('Failed to fetch history:', err);
            } finally {
                // Clear controller if this was the most recent fetch
                if (fetchId === lastHistoryFetchId) {
                    historyFetchController = null;
                    historyUpdatePending = false;
                }
            }
        }

        // Validate history data integrity
        function validateHistoryData(history, requestedMinutes) {
            if (!history || !history.points) {
                console.warn('Invalid history: missing points');
                return false;
            }

            // Check schema version
            if (history.schemaVersion !== 2) {
                console.warn('Invalid history: schema version mismatch');
                return false;
            }

            // Validate tier matches requested range
            const { tier, pointCount, expectedPointCount, dataAgeMs } = history;

            // Check if we have data
            if (pointCount === 0) {
                return true; // Empty data is valid (no data yet)
            }

            // Validate tier boundaries
            let expectedTier;
            if (requestedMinutes <= 60) expectedTier = 'fine';
            else if (requestedMinutes <= 1440) expectedTier = 'medium';
            else expectedTier = 'coarse';

            if (tier !== expectedTier) {
                console.warn('Tier mismatch: expected ' + expectedTier + ', got ' + tier);
                // This is acceptable if the higher tier has data
            }

            // Check data freshness for fine tier
            if (tier === 'fine' && dataAgeMs > 5000) {
                console.warn('Fine tier data is stale:', dataAgeMs, 'ms old');
                // Stale data is still usable, just warn
            }

            return true;
        }

        // Fetch logs
        async function fetchLogs() {
            try {
                const res = await fetch('/logs?limit=100');
                if (!res.ok) {
                    console.error('Logs endpoint returned:', res.status);
                    return;
                }
                const data = await res.json();
                if (data && data.logs) {
                    updateLogs(data.logs);
                }
            } catch (err) {
                console.error('Failed to fetch logs:', err);
            }
        }

        // ========== ISSUE DETECTION & DISPLAY ==========
        let previousIssuesHash = '';
        let lastIssuesStats = null;

        function detectIssues(stats) {
            const issues = [];

            // Check circuit breakers
            if (stats.keys) {
                stats.keys.forEach((key, idx) => {
                    if (key.circuitState === 'OPEN') {
                        issues.push({
                            severity: 'critical',
                            icon: '🔴',
                            title: `Key ${idx + 1} Circuit Open`,
                            description: 'Circuit breaker is open. Requests are failing.',
                            action: 'resetCircuit',
                            actionLabel: 'Reset Circuit',
                            actionData: idx
                        });
                    }
                    if (key.healthScore?.total < 40) {
                        issues.push({
                            severity: 'critical',
                            icon: '⚠️',
                            title: `Key ${idx + 1} Health Critical`,
                            description: `Health score is ${key.healthScore.total}/100`,
                            action: null
                        });
                    }
                });
            }

            // Check error rate
            const errorRate = stats.successRate !== undefined ? (100 - stats.successRate) : 0;
            if (errorRate > 5) {
                issues.push({
                    severity: 'warning',
                    icon: '📊',
                    title: 'High Error Rate',
                    description: `Error rate is ${errorRate.toFixed(1)}%`,
                    action: null
                });
            }

            // Check rate limiting (429s)
            const recent429s = stats.errors?.rateLimited || 0;
            if (recent429s > 10) {
                issues.push({
                    severity: 'warning',
                    icon: '🚫',
                    title: 'Rate Limiting Active',
                    description: `${recent429s} recent 429 responses`,
                    action: null
                });
            }

            // Check queue
            const queue = stats.backpressure?.queue;
            if (queue && queue.max > 0) {
                const queuePercent = (queue.current / queue.max) * 100;
                if (queuePercent > 80) {
                    issues.push({
                        severity: 'warning',
                        icon: '📦',
                        title: 'Queue Nearly Full',
                        description: `${Math.round(queuePercent)}% full (${queue.current}/${queue.max})`,
                        action: null
                    });
                }
            }

            // Check latency
            if (stats.latency?.p99 > 5000) {
                issues.push({
                    severity: 'warning',
                    icon: '⏱️',
                    title: 'High P99 Latency',
                    description: `P99 is ${stats.latency.p99}ms`,
                    action: null
                });
            }

            // Check connection health
            const connectionHealth = stats.connectionHealth || {};
            if (connectionHealth.consecutiveHangups > 5) {
                issues.push({
                    severity: 'critical',
                    icon: '🔌',
                    title: 'Connection Issues',
                    description: `${connectionHealth.consecutiveHangups} consecutive hangups`,
                    action: null
                });
            }

            return issues;
        }

        function updateIssuesPanel(stats) {
            const issues = detectIssues(stats);
            lastIssuesStats = stats;
            const panel = document.getElementById('issuesPanel');
            const issuesList = document.getElementById('issuesList');
            const issuesBadge = document.getElementById('issuesCountBadge');
            const issuesBadgeInScore = document.getElementById('issuesBadge');

            // Create hash for change detection
            const currentHash = issues.map(i => `${i.severity}-${i.title}`).join('|');
            const hasNewIssues = currentHash !== previousIssuesHash && currentHash !== '';
            previousIssuesHash = currentHash;

            // Check dismissed state
            const dismissedRaw = localStorage.getItem('issues-dismissed');
            if (dismissedRaw && issues.length > 0) {
                try {
                    const dismissed = JSON.parse(dismissedRaw);
                    if (dismissed.hash === currentHash) {
                        // Same issues still dismissed — show chip, hide panel
                        const reopenBadge = document.getElementById('issuesReopenBadge');
                        if (reopenBadge) {
                            document.getElementById('issuesReopenCount').textContent = issues.length;
                            reopenBadge.style.display = 'inline-flex';
                        }
                        panel.classList.remove('has-issues');
                        return;
                    } else {
                        // Hash changed — new issues, auto-clear dismiss
                        localStorage.removeItem('issues-dismissed');
                    }
                } catch (e) { localStorage.removeItem('issues-dismissed'); }
            }
            // Hide reopen badge when panel is active
            const reopenBadge = document.getElementById('issuesReopenBadge');
            if (reopenBadge) reopenBadge.style.display = 'none';

            // Update badges
            if (issuesBadge) {
                issuesBadge.textContent = issues.length;
                issuesBadge.className = 'issues-badge ' + (
                    issues.length === 0 ? 'none' : issues.length >= 3 ? 'critical' : 'warning'
                );
                issuesBadge.style.display = 'inline-flex';
            }

            if (issuesBadgeInScore) {
                issuesBadgeInScore.textContent = issues.length > 0 ? issues.length : '';
                issuesBadgeInScore.className = 'issues-badge ' + (
                    issues.length === 0 ? 'none' : issues.length >= 3 ? 'critical' : 'warning'
                );
                issuesBadgeInScore.style.display = issues.length > 0 ? 'inline-flex' : 'none';
            }

            // Show/hide panel
            if (issues.length === 0) {
                panel.classList.remove('has-issues', 'critical', 'warning', 'info');
                // Remove visual alerts from components
                document.querySelectorAll('.has-critical-issue, .has-warning-issue').forEach(el => {
                    el.classList.remove('has-critical-issue', 'has-warning-issue');
                });
                return;
            }

            panel.classList.add('has-issues');

            // Set severity class based on highest severity issue
            const hasCritical = issues.some(i => i.severity === 'critical');
            panel.className = 'issues-panel has-issues ' + (hasCritical ? 'critical' : 'warning');

            // Render issues
            issuesList.innerHTML = issues.map(issue => {
                let actionHtml = '';
                if (issue.action === 'resetCircuit') {
                    actionHtml = `<button class="issue-action" data-action="handle-issue-action" data-issue-action="resetCircuit" data-issue-data="${escapeHtml(issue.actionData || '')}">${escapeHtml(issue.actionLabel || 'Reset')}</button>`;
                }

                return `
                    <div class="issue-item ${issue.severity} ${hasNewIssues ? 'new-issue' : ''}">
                        <span class="issue-icon">${issue.icon}</span>
                        <div class="issue-details">
                            <div class="issue-title">${escapeHtml(issue.title)}</div>
                            <div class="issue-description">${escapeHtml(issue.description)}</div>
                        </div>
                        ${actionHtml}
                    </div>
                `;
            }).join('');

            // Apply visual alerts to components
            applyVisualAlerts(issues);

            // Show toast for new critical issues
            if (hasNewIssues && hasCritical) {
                showToast(`${issues.length} active issue${issues.length > 1 ? 's' : ''} detected`, 'error');
            } else if (hasNewIssues) {
                showToast(`${issues.length} issue${issues.length > 1 ? 's' : ''} detected`, 'warning');
            }
        }
        if (window.__DASHBOARD_DEBUG__) window.__DASHBOARD_DEBUG__.updateIssuesPanel = updateIssuesPanel;

        function applyVisualAlerts(issues) {
            // Remove existing alerts
            document.querySelectorAll('.has-critical-issue, .has-warning-issue').forEach(el => {
                el.classList.remove('has-critical-issue', 'has-warning-issue');
            });

            // Apply alerts based on issue types
            issues.forEach(issue => {
                if (issue.title.includes('Circuit Open')) {
                    const keyHealthSection = document.querySelector('.column-section:last-child .keys-section');
                    if (keyHealthSection) {
                        keyHealthSection.classList.add(issue.severity === 'critical' ? 'has-critical-issue' : 'has-warning-issue');
                    }
                }
                if (issue.title.includes('Queue')) {
                    const queueCard = document.querySelector('.info-card:has(#queueSize)');
                    if (queueCard) {
                        queueCard.classList.add('has-warning-issue');
                    }
                }
                if (issue.title.includes('Latency')) {
                    const performanceColumn = document.querySelector('.column-section:first-child');
                    if (performanceColumn) {
                        performanceColumn.classList.add('has-warning-issue');
                    }
                }
            });
        }

        function dismissIssues() {
            const panel = document.getElementById('issuesPanel');
            panel.classList.remove('has-issues');
            localStorage.setItem('issues-dismissed', JSON.stringify({
                hash: previousIssuesHash,
                dismissedAt: Date.now()
            }));
            // Show reopen chip
            const reopenBadge = document.getElementById('issuesReopenBadge');
            if (reopenBadge) reopenBadge.style.display = 'inline-flex';
            showToast('Issues dismissed', 'info');
        }

        // Handle issue action button clicks
        async function handleIssueAction(action, data) {
            switch (action) {
                case 'resetCircuit':
                    await forceCircuitStateOnKey(data, 'CLOSED');
                    break;
                default:
                    console.warn('Unknown issue action:', action);
            }
        }

        // Quick actions
        async function resetAllCircuits() {
            try {
                // Get all keys
                const statsRes = await fetch('/stats');
                const stats = await statsRes.json();

                if (stats.keys) {
                    for (let i = 0; i < stats.keys.length; i++) {
                        await fetch('/api/circuit/' + i, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ state: 'CLOSED' })
                        });
                    }
                    showToast('All circuits reset to CLOSED', 'success');
                    fetchStats();
                }
            } catch (err) {
                showToast('Failed to reset circuits: ' + err.message, 'error');
            }
        }

        async function clearQueue() {
            try {
                // This would need a backend endpoint - for now show a message
                showToast('Queue clear requested', 'info');
                // Trigger a stats refresh
                fetchStats();
            } catch (err) {
                showToast('Failed to clear queue: ' + err.message, 'error');
            }
        }

        async function exportDiagnostics() {
            try {
                const statsRes = await fetch('/stats');
                const stats = await statsRes.json();

                const diagnostics = {
                    timestamp: new Date().toISOString(),
                    uptime: stats.uptime,
                    uptimeFormatted: stats.uptimeFormatted,
                    successRate: stats.successRate,
                    latency: stats.latency,
                    errors: stats.errors,
                    keys: stats.keys?.map(k => ({
                        index: k.index,
                        state: k.circuitState,
                        healthScore: k.healthScore?.total,
                        totalRequests: k.total,
                        successRate: k.successRate
                    })),
                    backpressure: stats.backpressure,
                    connectionHealth: stats.connectionHealth
                };

                downloadFile(JSON.stringify(diagnostics, null, 2), 'glm-proxy-diagnostics.json', 'application/json');
                showToast('Diagnostics exported', 'success');
            } catch (err) {
                showToast('Failed to export diagnostics: ' + err.message, 'error');
            }
        }

        // Force circuit state on specific key
        async function forceCircuitStateOnKey(keyIndex, state) {
            try {
                const res = await fetch('/api/circuit/' + keyIndex, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ state })
                });

                if (res.ok) {
                    showToast('Key ' + (keyIndex + 1) + ' circuit set to ' + state, 'success');
                    fetchStats();
                } else {
                    showToast('Failed to update circuit state', 'error');
                }
            } catch (err) {
                showToast('Error: ' + err.message, 'error');
            }
        }

        // Update UI with stats
        function updateUI(stats) {
            // Store for per-model usage panel and other consumers
            STATE.statsData = stats;
            // Status
            const isPaused = stats.paused;
            const statusDot = document.getElementById('statusDot');
            const statusText = document.getElementById('statusText');
            statusDot.className = 'status-dot ' + (isPaused ? 'paused' : 'active');
            statusText.textContent = isPaused ? 'PAUSED' : 'ACTIVE';

            // Uptime
            const uptime = stats.uptime || 0;
            document.getElementById('uptime').textContent = formatUptime(uptime);
            // Mirror uptime to System page Connection Health card
            const systemUptimeEl = document.getElementById('systemUptime');
            if (systemUptimeEl) systemUptimeEl.textContent = formatUptime(uptime);

            // Requests per minute
            animateNumber('requestsPerMin', stats.requestsPerMinute || 0, '');

            // Success rate
            animateNumber('successRate', stats.successRate || 0, '%');

            // Average latency
            animateNumber('avgLatency', stats.latency?.avg || 0, 'ms');

            // Health score badge (NEW)
            updateHealthScoreBadge(stats);

            // Latency percentiles (NEW)
            animateNumber('p50Latency', stats.latency?.p50 || 0, '');
            animateNumber('p95Latency', stats.latency?.p95 || 0, '');
            animateNumber('p99Latency', stats.latency?.p99 || 0, '');

            // Token usage (NEW)
            const tokens = stats.tokens || {};
            document.getElementById('totalTokens').textContent = formatNumber(tokens.totalTokens || 0);
            document.getElementById('inputTokens').textContent = formatNumber(tokens.totalInputTokens || 0);
            document.getElementById('outputTokens').textContent = formatNumber(tokens.totalOutputTokens || 0);
            document.getElementById('avgTokensPerReq').textContent = tokens.avgTotalPerRequest || 0;

            // Show/hide token empty hint based on whether data exists
            const tokenHint = document.getElementById('tokenEmptyHint');
            if (tokenHint) {
                const hasTokenData = (tokens.totalTokens || 0) > 0;
                tokenHint.style.display = hasTokenData ? 'none' : 'block';
            }

            // Error breakdown (match API field names)
            const errors = stats.errors || {};
            document.getElementById('errorTimeouts').textContent = errors.timeouts || 0;
            document.getElementById('errorHangups').textContent = errors.socketHangups || 0;
            document.getElementById('errorServer').textContent = errors.serverErrors || 0;
            document.getElementById('errorRateLimited').textContent = errors.rateLimited || 0;
            document.getElementById('errorOverloaded').textContent = errors.connectionRefused || 0;
            document.getElementById('errorAuth').textContent = errors.authErrors || 0;

            // Update Request Distribution chart
            updateDistributionChart(stats);

            // Request semantics (client vs key attempts)
            const clientReq = stats.clientRequests || {};
            const keyAttempts = stats.keyAttempts || {};
            document.getElementById('clientRequests').textContent = formatNumber(clientReq.total || 0);
            document.getElementById('clientSuccessRate').textContent =
                (clientReq.successRate || 100) + '%';
            document.getElementById('keyAttempts').textContent = formatNumber(keyAttempts.total || 0);
            document.getElementById('inFlightRequests').textContent = clientReq.inFlight || 0;

            // Queue & backpressure
            const bp = stats.backpressure || {};
            const queue = bp.queue || {};
            document.getElementById('queueSize').textContent = queue.current || 0;
            document.getElementById('queueMax').textContent = queue.max || 100;
            document.getElementById('connections').textContent = bp.activeConnections || 0;
            document.getElementById('connectionsMax').textContent = bp.maxConnections || 100;

            const queuePercent = queue.max > 0 ? (queue.current / queue.max * 100) : 0;
            const queueProgressEl = document.getElementById('queueProgress');
            queueProgressEl.style.width = queuePercent + '%';
            queueProgressEl.className = 'progress-fill';
            if (queuePercent > 80) queueProgressEl.classList.add('warning');
            if (queuePercent >= 95) queueProgressEl.classList.add('critical');

            // Update progress bar with inline text
            const showInlineText = queuePercent >= 20;
            queueProgressEl.innerHTML = showInlineText
                ? `<span class="progress-fill-text">${queue.current}/${queue.max}</span>`
                : '';

            // Update progress label below bar
            const queuePercentEl = document.getElementById('queuePercent');
            queuePercentEl.innerHTML = `
                <span class="current-value">${queue.current}/${queue.max}</span>
                <span>${queuePercent.toFixed(0)}%</span>
            `;

            // Connection health
            const connectionHealth = stats.connectionHealth || {};
            document.getElementById('healthTotalHangups').textContent = connectionHealth.totalHangups || 0;
            document.getElementById('healthConsecutive').textContent = connectionHealth.consecutiveHangups || 0;
            document.getElementById('healthAgentRecreations').textContent = connectionHealth.agentRecreations || 0;
            document.getElementById('healthPoolAvgLatency').textContent =
                stats.poolAverageLatency ? (stats.poolAverageLatency.toFixed(0) + 'ms') : '-';

            // Rate limit status
            const rlStatus = stats.rateLimitStatus || {};
            document.getElementById('rlKeysAvailable').textContent = rlStatus.keysAvailable || stats.keys?.length || 0;
            document.getElementById('rlKeysInCooldown').textContent = rlStatus.keysInCooldown || 0;
            document.getElementById('rlTotal429s').textContent = rlStatus.total429s || 0;

            // Cooldown list
            const cooldownList = document.getElementById('rlCooldownList');
            if (rlStatus.cooldownKeys && rlStatus.cooldownKeys.length > 0) {
                cooldownList.innerHTML = 'Cooldown: ' + rlStatus.cooldownKeys
                    .map(k => 'K' + k.index + ' (' + Math.ceil(k.remainingMs/1000) + 's)')
                    .join(', ');
                cooldownList.style.color = 'var(--warning)';
            } else {
                cooldownList.innerHTML = 'All keys available';
                cooldownList.style.color = 'var(--success)';
            }

            // Health score distribution - Enhanced with percentage labels
            const scoreDist = stats.healthScoreDistribution || {};
            const scoreRanges = scoreDist.selectionsByScoreRange || {};
            const scoreTotal = (scoreRanges.excellent || 0) + (scoreRanges.good || 0) +
                              (scoreRanges.fair || 0) + (scoreRanges.poor || 0);

            if (scoreTotal > 0) {
                // Helper to update segment with text
                const updateScoreSegment = (id, count, total) => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    const percent = (count / total) * 100;
                    el.style.width = percent + '%';
                    // Show percentage if segment is wide enough (>15%), otherwise show count
                    const showPercent = percent >= 15;
                    const showCount = percent >= 8 && percent < 15;
                    el.innerHTML = (showPercent || showCount)
                        ? `<span class="score-segment-text">${showPercent ? percent.toFixed(0) + '%' : count}</span>`
                        : '';
                    // Mark tiny segments for CSS hiding
                    el.setAttribute('data-width', percent < 8 ? 'tiny' : 'normal');
                };

                updateScoreSegment('scoreExcellent', scoreRanges.excellent || 0, scoreTotal);
                updateScoreSegment('scoreGood', scoreRanges.good || 0, scoreTotal);
                updateScoreSegment('scoreFair', scoreRanges.fair || 0, scoreTotal);
                updateScoreSegment('scorePoor', scoreRanges.poor || 0, scoreTotal);
            }

            document.getElementById('scoreExcellentCount').textContent = scoreRanges.excellent || 0;
            document.getElementById('scoreGoodCount').textContent = scoreRanges.good || 0;
            document.getElementById('scoreFairCount').textContent = scoreRanges.fair || 0;
            document.getElementById('scorePoorCount').textContent = scoreRanges.poor || 0;
            document.getElementById('slowKeyEvents').textContent = scoreDist.slowKeyEvents || 0;
            document.getElementById('slowKeyRecoveries').textContent = scoreDist.slowKeyRecoveries || 0;

            // Keys heatmap
            STATE.keysData = stats.keys || [];
            updateKeysHeatmap(STATE.keysData);

            // Update key details if selected
            if (STATE.selectedKeyIndex !== null && STATE.keysData[STATE.selectedKeyIndex]) {
                updateKeyDetails(STATE.keysData[STATE.selectedKeyIndex]);
            }

            // Update tab content
            updateTabContent(stats);

            // Update issues panel
            updateIssuesPanel(stats);

            // Update Alert Bar (global header)
            updateAlertBar(stats);

            // Update Requests page summary cards and recent table
            updateRequestsPageSummary(stats);
        }

        // Update Requests page summary cards and recent requests table
        function updateRequestsPageSummary(stats) {
            const el = function(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; };
            const clientReq = stats.clientRequests || {};
            el('reqPageTotal', String(clientReq.total || stats.totalRequests || 0));
            el('reqPageSuccessRate', (stats.successRate || 0).toFixed(1) + '%');
            el('reqPageAvgLatency', (stats.latency && stats.latency.avg ? stats.latency.avg : 0).toFixed(0) + 'ms');

            // Count errors and in-flight from keys
            let errors = 0;
            const inFlight = clientReq.inFlight || 0;
            if (stats.keys) {
                stats.keys.forEach(function(k) { errors += (k.errors || 0); });
            }
            // Fallback: use error stats if keys don't have error counts
            if (errors === 0 && stats.errors) {
                const errObj = stats.errors;
                errors = (errObj.timeouts || 0) + (errObj.socketHangups || 0) +
                         (errObj.serverErrors || 0) + (errObj.rateLimited || 0) +
                         (errObj.connectionRefused || 0) + (errObj.authErrors || 0);
            }
            el('reqPageErrors', String(errors));
            el('reqPageInFlight', String(inFlight));

            // Update recent requests table from requestsHistory in state
            const tbody = document.getElementById('recentRequestsBody');
            if (!tbody) return;

            const history = STATE.requestsHistory || [];
            if (history.length === 0) return; // Keep empty state message

            // Show last 20 requests (newest first)
            const recent = history.slice(-20).reverse();
            const rows = [];
            for (let i = 0; i < recent.length; i++) {
                const r = recent[i];
                const time = formatTimestamp(r.timestamp || Date.now());
                const key = 'K' + (r.keyIndex != null ? r.keyIndex : '?');
                // Show both original and mapped models when mapping occurred
                let modelDisplay;
                if (r.mappedModel && r.mappedModel !== r.originalModel) {
                    // Mapping happened: show "original → mapped" format
                    const original = escapeHtml(r.originalModel || '');
                    const mapped = escapeHtml(r.mappedModel || '');
                    modelDisplay = `${original} &rarr; ${mapped}`;
                } else {
                    // No mapping: show single model
                    modelDisplay = escapeHtml(r.originalModel || r.mappedModel || '-');
                }
                const isSuccess = !r.error && (r.status === 'completed' || (r.statusCode >= 200 && r.statusCode < 300));
                const statusHtml = isSuccess
                    ? '<span style="color: var(--success, #22c55e);">✓ ' + escapeHtml(String(r.statusCode || 'OK')) + '</span>'
                    : '<span style="color: var(--error, #ef4444);">✗ ' + escapeHtml(String(r.statusCode || r.status || 'Error')) + '</span>';
                const latency = (r.latency || r.latencyMs || 0) + 'ms';
                rows.push(
                    '<tr style="border-bottom: 1px solid var(--border);">' +
                    '<td style="padding: 4px 8px; white-space: nowrap;">' + escapeHtml(time) + '</td>' +
                    '<td style="padding: 4px 8px;">' + escapeHtml(key) + '</td>' +
                    '<td style="padding: 4px 8px;">' + modelDisplay + '</td>' +
                    '<td style="padding: 4px 8px;">' + statusHtml + '</td>' +
                    '<td style="padding: 4px 8px; text-align: right;">' + escapeHtml(latency) + '</td>' +
                    '</tr>'
                );
            }
            tbody.innerHTML = rows.join('');
        }

        // Get health score class based on score value
        function getHealthScoreClass(score) {
            if (score >= 80) return 'excellent';
            if (score >= 60) return 'good';
            if (score >= 40) return 'fair';
            return 'poor';
        }

        // Update Alert Bar (global header metrics)
        function updateAlertBar(stats) {
            // Status
            const statusEl = document.getElementById('alertStatus');
            const statusContainer = document.getElementById('alertStatusContainer');
            const isPaused = stats.paused;
            if (statusEl) statusEl.textContent = isPaused ? 'PAUSED' : 'ACTIVE';
            if (statusContainer) {
                statusContainer.className = 'alert-item status ' + (isPaused ? 'paused' : '');
            }

            // Issues count (from health check)
            const issuesCount = calculateIssuesCount(stats);
            const issuesEl = document.getElementById('alertIssues');
            const issuesContainer = document.getElementById('alertIssuesContainer');
            if (issuesEl) issuesEl.textContent = issuesCount;
            if (issuesContainer) {
                issuesContainer.className = 'alert-item issues';
                if (issuesCount > 0) {
                    issuesContainer.classList.add(issuesCount >= 4 ? 'critical' : 'has-alert');
                }
            }

            // Circuit breakers open
            const openCircuits = calculateOpenCircuits(stats);
            const circuitsEl = document.getElementById('alertCircuits');
            const circuitsContainer = document.getElementById('alertCircuitsContainer');
            if (circuitsEl) circuitsEl.textContent = openCircuits;
            if (circuitsContainer) {
                circuitsContainer.className = 'alert-item circuits';
                if (openCircuits > 0) {
                    circuitsContainer.classList.add(openCircuits >= 2 ? 'critical' : 'has-alert');
                }
            }

            // Queue depth
            const bp = stats.backpressure || {};
            const queue = bp.queue || {};
            const queueDepth = queue.current || 0;
            const queueEl = document.getElementById('alertQueue');
            const queueContainer = document.getElementById('alertQueueContainer');
            if (queueEl) queueEl.textContent = queueDepth;
            if (queueContainer) {
                queueContainer.className = 'alert-item queue';
                if (queueDepth > 10) {
                    queueContainer.classList.add('critical');
                } else if (queueDepth > 0) {
                    queueContainer.classList.add('has-alert');
                }
            }

            // Uptime
            const uptimeEl = document.getElementById('alertUptime');
            if (uptimeEl) uptimeEl.textContent = formatUptimeShort(stats.uptime || 0);

                // Mirror circuits and queue to health ribbon
                const circuitsRibbon = document.getElementById('circuitsRibbonCount');
                if (circuitsRibbon) circuitsRibbon.textContent = String(openCircuits);
                const queueRibbon = document.getElementById('queueRibbonCount');
                if (queueRibbon) queueRibbon.textContent = String(queueDepth);

                // Update queue sub-text inside Circuits KPI card
                const queueInCircuits = document.getElementById('queueInCircuits');
                if (queueInCircuits) queueInCircuits.textContent = String(queueDepth);
        }

        // Calculate issues count from stats
        function calculateIssuesCount(stats) {
            let issues = 0;
            // Check for rate limit issues
            if (stats.rateLimitStatus?.keysInCooldown > 0) issues++;
            // Check for circuit breaker issues
            if (calculateOpenCircuits(stats) > 0) issues++;
            // Check for backpressure
            const bp = stats.backpressure || {};
            const queue = bp.queue || {};
            if (queue.current > 0) issues++;
            // Check for health score below 80
            if (stats.healthScore < 80) issues++;
            return issues;
        }

        // Calculate open circuit breakers
        function calculateOpenCircuits(stats) {
            if (!stats.keys || !Array.isArray(stats.keys)) return 0;
            return stats.keys.filter(k =>
                k.circuitState === 'open' || k.circuitState === 'half-open'
            ).length;
        }

        // Format uptime as compact string
        function formatUptimeShort(seconds) {
            if (!seconds || seconds < 0) return '0s';
            if (seconds < 60) return Math.floor(seconds) + 's';
            if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
            if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
            return Math.floor(seconds / 86400) + 'd';
        }

        // Update keys heatmap
        function updateKeysHeatmap(keys) {
            const heatmap = document.getElementById('keysHeatmap');
            if (!heatmap) return;

            const isCompact = STATE.settings.density === 'compact';

            heatmap.innerHTML = keys.map((key, index) => {
                const healthScore = key.healthScore?.total || 100;
                const healthClass = getHealthScoreClass(healthScore);
                const selected = index === STATE.selectedKeyIndex ? 'selected' : '';
                const inCooldown = key.rateLimitTracking?.inCooldown ? 'cooldown' : '';
                const inFlight = key.inFlight || 0;
                const hasInFlight = inFlight > 0 ? 'has-in-flight' : '';

                return `
                    <div class="heatmap-cell ${healthClass} ${selected} ${inCooldown} ${hasInFlight}"
                         data-action="select-key" data-key-index="${index}"
                         data-mouseenter="show-heatmap-tooltip" data-key-index-tooltip="${index}"
                         data-mouseleave="hide-heatmap-tooltip"
                         title="K${index}: Score ${healthScore}, ${inFlight} in-flight">
                        <span class="cell-label">K${index}</span>
                        <span class="cell-score">${healthScore}</span>
                        ${hasInFlight ? `<span class="in-flight-badge">${inFlight}</span>` : ''}
                    </div>
                `;
            }).join('');
        }

        // Show heatmap tooltip
        function showHeatmapTooltip(event, index) {
            const key = STATE.keysData[index];
            if (!key) return;

            // Remove existing tooltip
            hideHeatmapTooltip();

            const tooltip = document.createElement('div');
            tooltip.className = 'heatmap-tooltip';
            tooltip.id = 'heatmapTooltip';

            const healthScore = key.healthScore?.total || 100;
            const state = key.state || 'CLOSED';
            const successRate = key.successRate || 0;
            const avgLatency = key.latency?.avg || 0;
            const inFlight = key.inFlight || 0;
            const totalRequests = key.total || 0;

            tooltip.innerHTML = `
                <div style="font-weight: 600; margin-bottom: 4px;">Key K${index}</div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Health Score:</span>
                    <span class="tooltip-value">${healthScore}/100</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">State:</span>
                    <span class="tooltip-value">${state}</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Success Rate:</span>
                    <span class="tooltip-value">${successRate.toFixed(1)}%</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Avg Latency:</span>
                    <span class="tooltip-value">${avgLatency.toFixed(0)}ms</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">In Flight:</span>
                    <span class="tooltip-value">${inFlight}</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Total Requests:</span>
                    <span class="tooltip-value">${totalRequests}</span>
                </div>
            `;

            document.body.appendChild(tooltip);

            // Position tooltip
            const rect = event.target.getBoundingClientRect();
            tooltip.style.top = (rect.bottom + 8) + 'px';
            tooltip.style.left = (rect.left - 20) + 'px';
        }

        // Hide heatmap tooltip
        function hideHeatmapTooltip() {
            const tooltip = document.getElementById('heatmapTooltip');
            if (tooltip) {
                tooltip.remove();
            }
        }

        // Select key
        function selectKey(index) {
            STATE.selectedKeyIndex = index;
            const key = STATE.keysData[index];
            if (key) {
                document.getElementById('keyDetails').classList.add('visible');
                document.getElementById('keyDetailsTitle').textContent = `Key K${index}`;
                updateKeyDetails(key);
                fetchKeyOverrideCount(index);
            }
            updateKeysHeatmap(STATE.keysData);
        }

        // Fetch and display key override count
        // Updated: Reads from cached routing data instead of deprecated /model-mapping/keys endpoint
        function fetchKeyOverrideCount(keyIndex) {
            try {
                if (!STATE.routingData || !STATE.routingData.overrides) {
                    return;  // No routing data available
                }

                const overrides = STATE.routingData.overrides;
                // Check if there are per-key overrides for this key
                const keyOverrides = overrides[keyIndex] || {};
                const overrideCount = Object.keys(keyOverrides).length;

                const titleEl = document.getElementById('keyDetailsTitle');
                if (titleEl) {
                    // Remove existing badge if any
                    const existingBadge = titleEl.querySelector('.override-count-badge');
                    if (existingBadge) existingBadge.remove();

                    // Add badge if there are overrides
                    if (overrideCount > 0) {
                        titleEl.innerHTML += ' <span class="override-count-badge">' + overrideCount + ' override' + (overrideCount > 1 ? 's' : '') + '</span>';
                    }
                }
            } catch (err) {
                // Silently fail - override count is optional
            }
        }

        // Update key details
        function updateKeyDetails(key) {
            document.getElementById('detailCircuitState').textContent = key.state || 'CLOSED';
            document.getElementById('detailTotalRequests').textContent = key.total || 0;
            document.getElementById('detailSuccessRate').textContent =
                (key.successRate || 0).toFixed(1) + '%';
            document.getElementById('detailLatency').textContent =
                (key.latency?.avg || 0).toFixed(0) + 'ms';
            document.getElementById('detailActiveRequests').textContent = key.inFlight || 0;
            document.getElementById('detailFailures').textContent = key.failures || 0;

            // Update health score details
            const healthScore = key.healthScore || { total: 100, latency: 40, success: 40, errorRecency: 20 };
            document.getElementById('detailHealthScore').textContent = healthScore.total + '/100';
            document.getElementById('detailHealthLatency').textContent = healthScore.latency + '/40';
            document.getElementById('detailHealthSuccess').textContent = healthScore.success + '/40';
            document.getElementById('detailHealthRecency').textContent = healthScore.errorRecency + '/20';

            // Update slow key badge visibility
            const slowBadge = document.getElementById('detailSlowKeyBadge');
            if (slowBadge) {
                slowBadge.style.display = healthScore.isSlowKey ? 'inline-block' : 'none';
            }

            // Update rate limit tracking details
            const rateLimitTracking = key.rateLimitTracking || { count: 0, lastHit: null, inCooldown: false, cooldownRemaining: 0 };
            const statusEl = document.getElementById('detailRateLimitStatus');
            if (rateLimitTracking.inCooldown) {
                statusEl.textContent = 'IN COOLDOWN';
                statusEl.style.color = 'var(--danger)';
            } else if (rateLimitTracking.count > 0) {
                statusEl.textContent = 'OK (had 429s)';
                statusEl.style.color = 'var(--warning)';
            } else {
                statusEl.textContent = 'OK';
                statusEl.style.color = 'var(--success)';
            }
            document.getElementById('detailRateLimit429s').textContent = rateLimitTracking.count || 0;
            document.getElementById('detailRateLimitLastHit').textContent =
                formatTimestamp(rateLimitTracking.lastHit);
            document.getElementById('detailRateLimitCooldown').textContent =
                rateLimitTracking.inCooldown ? Math.ceil(rateLimitTracking.cooldownRemaining / 1000) + 's' : '-';
        }

        // Close key details
        function closeKeyDetails() {
            STATE.selectedKeyIndex = null;
            document.getElementById('keyDetails').classList.remove('visible');
            updateKeysHeatmap(STATE.keysData);
        }

        // ========== PHASE 2/3: TABBED INTERFACE (Dock Tabs) ==========
        function switchDockTab(tabName) {
            STATE.settings.activeTab = tabName;

            // Update dock tab buttons
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

            // Update dock panels (using same IDs as old tabs)
            document.querySelectorAll('.tab-panel').forEach(function(panel) {
                panel.classList.remove('active');
            });

            const activePanel = document.getElementById('tab-' + tabName);
            if (activePanel) {
                activePanel.classList.add('active');
            }

            // Update drawer title
            const titles = { live: 'Live Stream', traces: 'Request Traces', logs: 'Logs', queue: 'Queue', circuit: 'Circuit Status' };
            const titleEl = document.querySelector('.drawer-title');
            if (titleEl) titleEl.textContent = titles[tabName] || 'Live Stream';

            // Week 2: Load traces from API when switching to traces tab
            if (tabName === 'traces') {
                loadTracesFromAPI();
            }

            localStorage.setItem('dashboard-active-tab', tabName);
        }

        function switchTab(tabName) {
            // Delegate to dock tab switching (Phase 3)
            switchDockTab(tabName);
        }

        // ========== ROUTING PAGE TABS ==========
        function switchRoutingTab(tabName) {
            document.querySelectorAll('.routing-tab-btn').forEach(function(btn) {
                const isActive = btn.dataset.routingTab === tabName;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-selected', String(isActive));
                btn.setAttribute('tabindex', isActive ? '0' : '-1');
            });
            document.querySelectorAll('.routing-tab-panel').forEach(function(panel) {
                panel.classList.toggle('active', panel.dataset.routingPanel === tabName);
            });
            localStorage.setItem('dashboard-routing-tab', tabName);

            // Resize charts when Observability tab becomes visible (Chart.js canvas sizing issue)
            if (tabName === 'observability') {
                if (routingTierChart) routingTierChart.resize();
                if (routingSourceChart) routingSourceChart.resize();
                if (routing429Chart) routing429Chart.resize();
            }
        }

        function loadActiveTab() {
            const savedTab = localStorage.getItem('dashboard-active-tab') || 'live';
            switchTab(savedTab);
        }

        // ========== TOP-LEVEL PAGE NAVIGATION ==========
        STATE.activePage = 'overview';

        function switchPage(pageName) {
            STATE.activePage = pageName;

            // Update page nav buttons
            document.querySelectorAll('.page-nav-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.page === pageName);
            });

            // Update ARIA on page nav
            document.querySelectorAll('.page-nav-btn').forEach(function(btn) {
                const isActive = btn.dataset.page === pageName;
                btn.setAttribute('aria-selected', String(isActive));
                btn.setAttribute('tabindex', isActive ? '0' : '-1');
                // Update aria-current for accessibility
                if (isActive) {
                    btn.setAttribute('aria-current', 'page');
                } else {
                    btn.removeAttribute('aria-current');
                }
            });

            // Show/hide page sections (supports space-separated multi-page membership)
            document.querySelectorAll('.page-section[data-belongs-to]').forEach(section => {
                const pages = section.dataset.belongsTo.split(' ');
                section.classList.toggle('page-hidden', !pages.includes(pageName));
            });

            // When switching to requests page, restore the active sub-tab
            if (pageName === 'requests') {
                loadActiveRequestTab();
            }

            // Stop pool polling when leaving model routing page
            if (pageName !== 'models' && typeof stopPoolPolling === 'function') {
                stopPoolPolling();
            }

            localStorage.setItem('dashboard-active-page', pageName);
        }

        function loadActivePage() {
            const savedPage = localStorage.getItem('dashboard-active-page') || 'overview';
            switchPage(savedPage);
        }

        // ========== PHASE 4c: REQUESTS PAGE SUB-TAB SWITCHING ==========
        function switchRequestTab(tabName) {
            // Toggle sub-tab active state
            document.querySelectorAll('#requestsSubTabs .sub-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.tab === tabName);
            });

            // Toggle content sections
            // data-tab can be space-separated (e.g. "live traces") to match multiple tabs
            document.querySelectorAll('.request-tab-content[data-belongs-to="requests"]').forEach(function(s) {
                const sectionTab = s.dataset.tab;
                if (!sectionTab) return;  // Skip sub-tabs nav itself
                const matchesTab = sectionTab.split(' ').indexOf(tabName) !== -1;
                s.classList.toggle('page-hidden', !matchesTab);
            });

            // Switch the active dock tab to match the sub-tab
            if (tabName === 'live' || tabName === 'traces') {
                switchDockTab(tabName);
                // Load traces if switching to traces sub-tab
                if (tabName === 'traces' && typeof loadTracesFromAPI === 'function') {
                    loadTracesFromAPI();
                }
            }

            localStorage.setItem('dashboard-request-tab', tabName);
        }

        function loadActiveRequestTab() {
            const savedTab = localStorage.getItem('dashboard-request-tab') || 'table';
            switchRequestTab(savedTab);
        }

        // Phase 5: Initialize ARIA attributes (dynamic updates on page changes)
        function initARIA() {
            // Set initial ARIA for active page (guards against missing initial state)
            const activePageBtn = document.querySelector('.page-nav-btn.active');
            if (activePageBtn) {
                activePageBtn.setAttribute('aria-selected', 'true');
                activePageBtn.setAttribute('tabindex', '0');
            }

            // Search input ARIA (already set in HTML, this ensures it's present)
            const searchInput = document.getElementById('globalSearchInput');
            if (searchInput && !searchInput.getAttribute('aria-label')) {
                searchInput.setAttribute('aria-label', 'Search requests');
                searchInput.setAttribute('aria-controls', 'searchResults');
            }

            // Initialize dock tab ARIA
            document.querySelectorAll('.dock-tab').forEach(btn => {
                const isActive = btn.classList.contains('active');
                btn.setAttribute('aria-selected', String(isActive));
                btn.setAttribute('tabindex', isActive ? '0' : '-1');
            });
        }

        function updateTabContent(stats) {
            // Update Queue tab
            const bp = stats.backpressure || {};
            const queue = bp.queue || {};
            document.getElementById('queueSizeTab').textContent = queue.current || 0;
            document.getElementById('queueMaxTab').textContent = queue.max || 100;
            document.getElementById('connectionsTab').textContent = bp.activeConnections || 0;
            document.getElementById('connectionsMaxTab').textContent = bp.maxConnections || 100;

            const queuePercent = queue.max > 0 ? (queue.current / queue.max * 100) : 0;
            const queueProgressTabEl = document.getElementById('queueProgressTab');
            queueProgressTabEl.style.width = queuePercent + '%';
            queueProgressTabEl.className = 'progress-fill';
            if (queuePercent > 80) queueProgressTabEl.classList.add('warning');
            if (queuePercent >= 95) queueProgressTabEl.classList.add('critical');

            // Update progress bar with inline text
            const showInlineText = queuePercent >= 20;
            queueProgressTabEl.innerHTML = showInlineText
                ? `<span class="progress-fill-text">${queue.current}/${queue.max}</span>`
                : '';

            // Update progress label below bar
            const queuePercentTabEl = document.getElementById('queuePercentTab');
            queuePercentTabEl.innerHTML = `
                <span class="current-value">${queue.current}/${queue.max}</span>
                <span>${queuePercent.toFixed(0)}%</span>
            `;

            // Backpressure status
            const backpressureStatus = document.getElementById('backpressureStatus');
            if (queue.current > queue.max * 0.8) {
                backpressureStatus.textContent = '⚠️ High queue usage - backpressure active';
                backpressureStatus.style.color = 'var(--warning)';
            } else if (queue.current > queue.max * 0.5) {
                backpressureStatus.textContent = 'Moderate queue usage';
                backpressureStatus.style.color = 'var(--text-secondary)';
            } else {
                backpressureStatus.textContent = 'Normal operation';
                backpressureStatus.style.color = 'var(--success)';
            }

            // Update Circuit tab health scores - Enhanced with percentage labels
            const scoreDist = stats.healthScoreDistribution || {};
            const scoreRanges = scoreDist.selectionsByScoreRange || {};
            const scoreTotal = (scoreRanges.excellent || 0) + (scoreRanges.good || 0) +
                              (scoreRanges.fair || 0) + (scoreRanges.poor || 0);

            if (scoreTotal > 0) {
                // Helper to update segment with text
                const updateTabScoreSegment = (id, count, total) => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    const percent = (count / total) * 100;
                    el.style.width = percent + '%';
                    // Show percentage if segment is wide enough (>15%), otherwise show count
                    const showPercent = percent >= 15;
                    const showCount = percent >= 8 && percent < 15;
                    el.innerHTML = (showPercent || showCount)
                        ? `<span class="score-segment-text">${showPercent ? percent.toFixed(0) + '%' : count}</span>`
                        : '';
                    // Mark tiny segments for CSS hiding
                    el.setAttribute('data-width', percent < 8 ? 'tiny' : 'normal');
                };

                updateTabScoreSegment('tabScoreExcellent', scoreRanges.excellent || 0, scoreTotal);
                updateTabScoreSegment('tabScoreGood', scoreRanges.good || 0, scoreTotal);
                updateTabScoreSegment('tabScoreFair', scoreRanges.fair || 0, scoreTotal);
                updateTabScoreSegment('tabScorePoor', scoreRanges.poor || 0, scoreTotal);
            }

            document.getElementById('tabScoreExcellentCount').textContent = scoreRanges.excellent || 0;
            document.getElementById('tabScoreGoodCount').textContent = scoreRanges.good || 0;
            document.getElementById('tabScoreFairCount').textContent = scoreRanges.fair || 0;
            document.getElementById('tabScorePoorCount').textContent = scoreRanges.poor || 0;
        }

        function getAuthHeaders() {
            const headers = {};
            const token = localStorage.getItem('adminToken');
            if (token) headers['x-admin-token'] = token;
            return headers;
        }

        function updateTracesTable(request) {
            // Add to traces array (for real-time updates from SSE)
            STATE.traces.unshift({
                timestamp: request.timestamp,
                keyIndex: request.keyIndex,
                path: request.path,
                status: request.error ? 'error' : request.status === 'completed' ? 'success' : 'pending',
                latency: request.latency,
                traceId: request.requestId || null,
                attempts: 1,
                queueDuration: null
            });

            // Keep only last 100
            if (STATE.traces.length > 100) {
                STATE.traces = STATE.traces.slice(0, 100);
            }

            renderTracesTable();
        }

        // Week 2: Load traces from /traces API (Enhanced in Week 7)
        async function loadTracesFromAPI() {
            const statusFilter = document.getElementById('traceFilterStatus')?.value;
            const retriesFilter = document.getElementById('traceFilterRetries')?.value;
            const timeRangeFilter = document.getElementById('traceFilterTimeRange')?.value;
            const latencyFilter = document.getElementById('traceFilterLatency')?.value;
            const pathFilter = document.getElementById('traceFilterPath')?.value;

            // Build query params
            const params = new URLSearchParams();
            if (statusFilter) params.set('success', statusFilter);
            if (retriesFilter === 'true') params.set('hasRetries', 'true');
            if (latencyFilter) params.set('minDuration', latencyFilter);
            if (timeRangeFilter) {
                const since = Date.now() - (parseInt(timeRangeFilter, 10) * 60 * 1000);
                params.set('since', new Date(since).toISOString());
            }
            params.set('limit', '100');

            try {
                const url = '/traces' + (params.toString() ? '?' + params.toString() : '');
                const response = await fetch(url, {
                    headers: getAuthHeaders()
                });

                if (!response.ok) {
                    throw new Error('Failed to fetch traces');
                }

                const data = await response.json();
                let traces = data.traces || [];

                // Client-side path filter (Week 7)
                if (pathFilter && pathFilter.trim()) {
                    const filterLower = pathFilter.toLowerCase().trim();
                    traces = traces.filter(t => (t.path || '').toLowerCase().includes(filterLower));
                }

                // Update STATE with filtered traces
                STATE.apiTraces = traces;

                // Calculate and update stats (Week 7 enhanced)
                const successCount = traces.filter(t => t.success).length;
                const failedCount = traces.filter(t => !t.success).length;
                const retryCount = traces.filter(t => (t.attempts || 1) > 1).length;
                const avgLatency = traces.length > 0
                    ? Math.round(traces.reduce((sum, t) => sum + (t.totalDuration || 0), 0) / traces.length)
                    : 0;

                document.getElementById('traceStatsCount').textContent = traces.length + ' traces';
                document.getElementById('traceStatsSuccess').textContent = successCount + ' success';
                const failedEl = document.getElementById('traceStatsFailed');
                if (failedEl) failedEl.textContent = failedCount + ' failed';
                document.getElementById('traceStatsRetries').textContent = retryCount + ' with retries';
                const avgEl = document.getElementById('traceStatsAvgLatency');
                if (avgEl) avgEl.textContent = 'Avg: ' + avgLatency + 'ms';

                renderAPITracesTable();
            } catch (err) {
                console.error('Failed to load traces:', err);
                showToast('Failed to load traces: ' + err.message, 'error');
            }
        }

        function renderTracesTable() {
            const tbody = document.getElementById('tracesBody');
            if (!tbody) return;

            tbody.innerHTML = STATE.traces.map(t => {
                const time = formatTimestamp(t.timestamp);
                const statusClass = t.status === 'success' ? 'success' : t.status === 'error' ? 'error' : 'pending';
                const statusIcon = t.status === 'success' ? '✓' : t.status === 'error' ? '✕' : '⋯';
                const safePath = escapeHtml(t.path || '/v1/messages');
                const shortTraceId = t.traceId ? t.traceId.substring(0, 12) + '...' : '-';

                return `
                    <tr data-trace-id="${escapeHtml(t.traceId || '')}" data-action="show-trace" style="cursor: pointer;">
                        <td class="monospace">${time}</td>
                        <td class="monospace" title="${escapeHtml(t.traceId || '')}">${shortTraceId}</td>
                        <td>${safePath}</td>
                        <td>${t.attempts || 1}</td>
                        <td class="monospace">${t.queueDuration ? t.queueDuration + 'ms' : '-'}</td>
                        <td class="monospace">${t.latency ? t.latency + 'ms' : '-'}</td>
                        <td><span class="trace-status ${statusClass}"></span>${statusIcon}</td>
                    </tr>
                `;
            }).join('');
        }

        function renderAPITracesTable() {
            const tbody = document.getElementById('tracesBody');
            if (!tbody) return;

            const traces = STATE.apiTraces || [];

            if (traces.length === 0) {
                tbody.innerHTML = renderTableEmptyState(8, 'No traces found');
                return;
            }

            tbody.innerHTML = traces.map(t => {
                const time = formatTimestamp(t.startTime);
                const statusClass = t.success ? 'success' : 'error';
                const statusIcon = t.success ? '✓' : '✕';
                const safePath = escapeHtml(t.path || '/v1/messages');
                const shortTraceId = t.traceId ? t.traceId.substring(0, 12) + '...' : '-';
                const model = t.model ? escapeHtml(t.model.split('/').pop().substring(0, 12)) : '-';
                const attempts = t.attempts || 1;
                const attemptsClass = attempts > 1 ? 'style="color: var(--warning);"' : '';

                return `
                    <tr data-trace-id="${escapeHtml(t.traceId)}" data-action="show-trace" style="cursor: pointer;">
                        <td class="monospace">${time}</td>
                        <td class="monospace" title="${escapeHtml(t.traceId)}">${shortTraceId}</td>
                        <td title="${safePath}">${safePath.length > 25 ? safePath.substring(0, 25) + '...' : safePath}</td>
                        <td class="monospace" style="font-size: 0.7rem;" title="${escapeHtml(t.model || '')}">${model}</td>
                        <td ${attemptsClass}>${attempts}</td>
                        <td class="monospace">${t.queueDuration ? t.queueDuration + 'ms' : '-'}</td>
                        <td class="monospace">${t.totalDuration ? t.totalDuration + 'ms' : '-'}</td>
                        <td><span class="trace-status ${statusClass}"></span>${statusIcon}</td>
                    </tr>
                `;
            }).join('');
        }

        // Week 2: Show trace detail panel (Enhanced in Week 7)
        let currentTraceData = null; // Store for copy functions

        async function showTraceDetail(traceId) {
            if (!traceId) return;

            const panel = document.getElementById('traceDetailPanel');
            panel.style.display = 'block';

            // Show loading state in enhanced panel
            document.getElementById('traceDetailId').textContent = traceId;
            document.getElementById('traceDetailStatus').textContent = 'Loading...';
            document.getElementById('traceDetailModel').textContent = '-';
            document.getElementById('traceDetailDuration').textContent = '-';
            document.getElementById('traceDetailAttempts').textContent = '-';
            document.getElementById('traceDetailQueue').textContent = '-';
            document.getElementById('traceDetailKey').textContent = '-';
            document.getElementById('traceTimeline').innerHTML = '<div style="color: var(--text-secondary);">Loading...</div>';
            document.getElementById('traceAttemptsList').innerHTML = '';
            document.getElementById('traceErrorSection').style.display = 'none';
            document.getElementById('traceDetailRaw').textContent = '';

            try {
                const response = await fetch('/traces/' + encodeURIComponent(traceId), {
                    headers: getAuthHeaders()
                });

                if (!response.ok) {
                    throw new Error('Trace not found');
                }

                const data = await response.json();
                const trace = data.trace;
                currentTraceData = trace;

                // Update summary section
                const statusEl = document.getElementById('traceDetailStatus');
                statusEl.textContent = trace.success ? 'Success' : 'Failed';
                statusEl.style.color = trace.success ? 'var(--success)' : 'var(--danger)';

                document.getElementById('traceDetailModel').textContent = trace.model || 'N/A';
                document.getElementById('traceDetailDuration').textContent = trace.totalDuration ? trace.totalDuration + 'ms' : '-';
                document.getElementById('traceDetailAttempts').textContent = (trace.attempts?.length || 1) + ' attempt(s)';
                document.getElementById('traceDetailQueue').textContent = trace.queueDuration ? trace.queueDuration + 'ms' : '-';

                // Show key used (from last attempt)
                const lastAttempt = trace.attempts?.[trace.attempts.length - 1];
                document.getElementById('traceDetailKey').textContent = lastAttempt
                    ? '#' + lastAttempt.keyIndex + ' (' + (lastAttempt.keyId || 'unknown').substring(0, 12) + ')'
                    : '-';

                // Render timeline (Week 7)
                renderTraceTimeline(trace);

                // Render attempts list (Week 7)
                renderTraceAttempts(trace);

                // Show error section if failed
                if (!trace.success && trace.finalError) {
                    document.getElementById('traceErrorSection').style.display = 'block';
                    document.getElementById('traceErrorContent').textContent = trace.finalError;
                }

                // Populate raw data
                document.getElementById('traceDetailRaw').textContent = JSON.stringify(trace, null, 2);

            } catch (err) {
                document.getElementById('traceDetailStatus').textContent = 'Error';
                document.getElementById('traceDetailStatus').style.color = 'var(--danger)';
                document.getElementById('traceTimeline').innerHTML = '<div style="color: var(--danger);">Error: ' + escapeHtml(err.message) + '</div>';
            }
        }

        // Week 7: Render trace timeline visualization
        function renderTraceTimeline(trace) {
            const container = document.getElementById('traceTimeline');
            if (!trace.totalDuration || trace.totalDuration === 0) {
                container.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.7rem;">No timing data available</div>';
                return;
            }

            const total = trace.totalDuration;
            const queueTime = trace.queueDuration || 0;
            const queuePct = Math.min((queueTime / total) * 100, 100);

            let segments = [];
            if (queueTime > 0) {
                segments.push({ type: 'queue', pct: queuePct, label: 'Queue ' + queueTime + 'ms' });
            }

            if (trace.attempts && trace.attempts.length > 0) {
                const processingTime = total - queueTime;
                let remainingPct = 100 - queuePct;

                trace.attempts.forEach((attempt, i) => {
                    const attemptDuration = attempt.duration || 0;
                    const attemptPct = processingTime > 0 ? (attemptDuration / processingTime) * remainingPct : remainingPct / trace.attempts.length;
                    const type = attempt.success ? 'success' : (i < trace.attempts.length - 1 ? 'retry' : 'processing');
                    segments.push({ type, pct: Math.max(attemptPct, 2), label: 'Attempt ' + (i + 1) + ': ' + attemptDuration + 'ms' });
                });
            } else {
                segments.push({ type: trace.success ? 'success' : 'processing', pct: 100 - queuePct, label: 'Processing' });
            }

            const barsHtml = segments.map(s =>
                '<div class="trace-timeline-bar ' + s.type + '" style="width: ' + s.pct + '%; flex-shrink: 0;" title="' + escapeHtml(s.label) + '"></div>'
            ).join('');

            container.innerHTML = `
                <div class="trace-timeline-label start">${formatTimestamp(trace.startTime)}</div>
                <div class="trace-timeline-label end">${trace.endTime ? formatTimestamp(trace.endTime) : 'In Progress'}</div>
                <div style="display: flex; width: 100%; gap: 2px; margin-top: 8px;">${barsHtml}</div>
                <div style="font-size: 0.6rem; color: var(--text-secondary); margin-top: 4px; display: flex; gap: 12px;">
                    <span><span style="display: inline-block; width: 8px; height: 8px; background: var(--warning); border-radius: 2px;"></span> Queue</span>
                    <span><span style="display: inline-block; width: 8px; height: 8px; background: var(--primary); border-radius: 2px;"></span> Processing</span>
                    <span><span style="display: inline-block; width: 8px; height: 8px; background: var(--success); border-radius: 2px;"></span> Success</span>
                    <span><span style="display: inline-block; width: 8px; height: 8px; background: var(--danger); opacity: 0.7; border-radius: 2px;"></span> Retry</span>
                </div>
            `;
        }

        // Week 7: Render trace attempts list
        function renderTraceAttempts(trace) {
            const container = document.getElementById('traceAttemptsList');
            if (!trace.attempts || trace.attempts.length === 0) {
                container.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.7rem;">No attempt data available</div>';
                return;
            }

            container.innerHTML = trace.attempts.map((attempt, i) => {
                const isLast = i === trace.attempts.length - 1;
                const statusClass = attempt.success ? 'success' : (isLast ? 'failed' : 'retried');
                const statusText = attempt.success ? 'Success' : (isLast ? 'Failed' : 'Retried');

                return `
                    <div class="trace-attempt-card ${statusClass}">
                        <div class="trace-attempt-header">
                            <span class="attempt-num">Attempt ${i + 1}</span>
                            <span class="attempt-status ${attempt.success ? 'success' : 'failed'}">${statusText}</span>
                        </div>
                        <div class="trace-attempt-details">
                            <div class="trace-attempt-detail">
                                <span class="label">Key</span>
                                <span>#${attempt.keyIndex} (${escapeHtml((attempt.keyId || 'unknown').substring(0, 12))})</span>
                            </div>
                            <div class="trace-attempt-detail">
                                <span class="label">Duration</span>
                                <span>${attempt.duration ? attempt.duration + 'ms' : '-'}</span>
                            </div>
                            <div class="trace-attempt-detail">
                                <span class="label">Selection</span>
                                <span>${escapeHtml(attempt.selectionReason || 'N/A')}</span>
                            </div>
                            ${attempt.error ? '<div class="trace-attempt-detail" style="grid-column: 1 / -1;"><span class="label">Error</span><span style="color: var(--danger);">' + escapeHtml(attempt.error) + '</span></div>' : ''}
                            ${attempt.retryReason ? '<div class="trace-attempt-detail"><span class="label">Retry Reason</span><span>' + escapeHtml(attempt.retryReason) + '</span></div>' : ''}
                        </div>
                    </div>
                `;
            }).join('');
        }

        // Make showTraceDetail globally accessible
        window.showTraceDetail = showTraceDetail;

        function closeTraceDetail() {
            const panel = document.getElementById('traceDetailPanel');
            if (panel) {
                panel.style.display = 'none';
            }
            currentTraceData = null;
        }

        // Week 7: Search by trace ID
        function searchTraceById() {
            const searchInput = document.getElementById('traceSearchId');
            const traceId = searchInput ? (searchInput.value || '').trim() : '';
            const notFound = document.getElementById('traceNotFound');
            if (notFound) notFound.style.display = 'none';
            if (traceId && traceId.length >= 8) {
                showTraceDetail(traceId);
                setTimeout(function() {
                    const detailPanel = document.getElementById('traceDetailPanel');
                    if (detailPanel && detailPanel.style.display === 'none' && notFound) {
                        notFound.style.display = 'block';
                    }
                }, 500);
            }
        }

        // Week 7: Export filtered traces
        function exportTraces() {
            const traces = STATE.apiTraces || [];
            if (traces.length === 0) {
                showToast('No traces to export', 'warning');
                return;
            }
            const data = { exportedAt: new Date().toISOString(), count: traces.length, traces: traces };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'traces-export-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('Exported ' + traces.length + ' traces', 'success');
        }

        // Week 7: Clear all trace filters
        function clearTraceFilters() {
            ['traceFilterStatus', 'traceFilterRetries', 'traceFilterTimeRange', 'traceFilterLatency', 'traceFilterPath', 'traceSearchId'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            loadTracesFromAPI();
        }

        // Week 7: Copy trace ID
        function copyTraceId() {
            if (currentTraceData?.traceId) {
                navigator.clipboard.writeText(currentTraceData.traceId).then(() => showToast('Trace ID copied', 'success')).catch(() => showToast('Failed to copy', 'error'));
            }
        }

        // Week 7: Copy trace JSON
        function copyTraceJson() {
            if (currentTraceData) {
                navigator.clipboard.writeText(JSON.stringify(currentTraceData, null, 2)).then(() => showToast('Trace JSON copied', 'success')).catch(() => showToast('Failed to copy', 'error'));
            }
        }

        function addCircuitEvent(keyIndex, fromState, toState) {
            const event = {
                timestamp: Date.now(),
                keyIndex,
                fromState,
                toState
            };

            STATE.circuitEvents.unshift(event);
            if (STATE.circuitEvents.length > 50) {
                STATE.circuitEvents = STATE.circuitEvents.slice(0, 50);
            }

            updateCircuitTimeline();
        }

        function updateCircuitTimeline() {
            const container = document.getElementById('circuitTimeline');
            if (STATE.circuitEvents.length === 0) {
                container.innerHTML = '<div style="color: var(--text-secondary); text-align: center; padding: 20px;">No state changes yet</div>';
                return;
            }

            container.innerHTML = `
                <div class="timeline-line"></div>
                ${STATE.circuitEvents.map(e => {
                    const time = formatTimestamp(e.timestamp);
                    const stateClass = 'to-' + e.toState.toLowerCase().replace('_', '-');
                    return `
                        <div class="timeline-item">
                            <div class="timeline-dot ${stateClass}"></div>
                            <div class="timeline-content">
                                <div class="timeline-time">${time}</div>
                                <div class="timeline-text">K${e.keyIndex}: ${e.fromState} → ${e.toState}</div>
                            </div>
                        </div>
                    `;
                }).join('')}
            `;
        }

        // Update charts
        function updateCharts(history) {
            if (!requestChart) return;
            const points = history.points || [];
            if (points.length === 0) return;

            // Use tier metadata for smart rendering
            const tier = history.tier || 'fine';
            const tierResolution = history.tierResolution || 1;

            // Format labels based on tier resolution
            const formatTimeForTier = (timestamp) => {
                if (tierResolution >= 60) {
                    // Coarse tier (60s): show HH:MM
                    return formatTimestamp(timestamp, {compact: true});
                } else {
                    // Medium/Fine tier: show HH:MM:SS
                    return formatTimestamp(timestamp);
                }
            };

            // Smart downsampling: only downsample if significantly over chart limits
            // Chart.js can handle 500-1000 points efficiently
            // Don't downsample if data is already pre-sampled by the backend tier
            let chartPoints = points;
            const maxChartPoints = 200; // Maximum points for smooth chart rendering

            if (points.length > maxChartPoints) {
                // Use larger step for larger datasets
                const step = Math.ceil(points.length / maxChartPoints);
                chartPoints = points.filter((_, i) => i % step === 0);
            }

            const labels = chartPoints.map(p => formatTimeForTier(p.timestamp));

            // Update data quality indicator
            updateDataQualityIndicator(history, chartPoints.length);

            // Requests chart (requests per interval from history)
            // For fine tier: requests per second; for medium/coarse: requests per 10s/60s
            requestChart.data.labels = labels;
            requestChart.data.datasets[0].data = chartPoints.map(p => p.requests || 0);
            requestChart.update('none');

            // Latency chart
            latencyChart.data.labels = labels;
            latencyChart.data.datasets[0].data = chartPoints.map(p => p.avgLatency || 0);
            latencyChart.update('none');

            // Error rate chart
            if (STATE.charts.error && chartPoints.length > 0) {
                STATE.charts.error.data.labels = labels;
                STATE.charts.error.data.datasets[0].data = chartPoints.map(p => p.errorRate || 0);
                STATE.charts.error.update('none');
            }

            // Toggle chart empty states based on data availability
            const hasRequestData = requestChart && requestChart.data.datasets[0] && requestChart.data.datasets[0].data.length > 0;
            const hasLatencyData = latencyChart && latencyChart.data.datasets[0] && latencyChart.data.datasets[0].data.length > 0;
            const hasErrorData = STATE.charts.error && STATE.charts.error.data.datasets[0] && STATE.charts.error.data.datasets[0].data.length > 0;

            const requestEmptyEl = document.getElementById('requestChartEmpty');
            const latencyEmptyEl = document.getElementById('latencyChartEmpty');
            const errorEmptyEl = document.getElementById('errorChartEmpty');

            if (requestEmptyEl) requestEmptyEl.style.display = hasRequestData ? 'none' : 'block';
            if (latencyEmptyEl) latencyEmptyEl.style.display = hasLatencyData ? 'none' : 'block';
            if (errorEmptyEl) errorEmptyEl.style.display = hasErrorData ? 'none' : 'block';

            // Update routing observability charts from history data
            if (routingTierChart) {
                updateRouting429Chart(history);
                updateRoutingObsKPIs(history);
            }
        }

        // Update data quality indicator based on tier coverage
        function updateDataQualityIndicator(history, chartPointCount) {
            const { tier, pointCount, expectedPointCount, minutes } = history;

            // Calculate coverage ratio
            const coverage = expectedPointCount > 0 ? pointCount / expectedPointCount : 1;

            let quality = 'good';
            let message = '';

            if (tier === 'fine') {
                if (coverage < 0.5 && minutes > 30) {
                    quality = 'warning';
                    message = 'Limited fine-grain data';
                } else {
                    message = 'Real-time data';
                }
            } else if (tier === 'medium') {
                message = '10s resolution';
            } else if (tier === 'coarse') {
                message = '60s resolution';
            }

            // Update all three chart indicators
            const indicators = ['dataQualityIndicator', 'dataQualityIndicator2', 'dataQualityIndicator3'];
            indicators.forEach(id => {
                const indicator = document.getElementById(id);
                if (indicator) {
                    indicator.textContent = message;
                    indicator.className = 'data-quality-indicator ' + quality;
                }
            });
        }

        // Update Request Distribution chart
        function updateDistributionChart(stats) {
            if (!STATE.charts.dist) return;

            const clientReq = stats.clientRequests || {};
            const errors = stats.errors || {};

            // Build distribution data: successes vs error types
            const labels = [];
            const data = [];
            const colors = [];

            // Successes
            if (clientReq.succeeded > 0) {
                labels.push('Success');
                data.push(clientReq.succeeded);
                colors.push('#22c55e');  // Green
            }

            // Error types
            const errorTypes = [
                { key: 'timeouts', label: 'Timeouts', color: '#f59e0b' },
                { key: 'socketHangups', label: 'Hangups', color: '#ef4444' },
                { key: 'serverErrors', label: 'Server Errors', color: '#dc2626' },
                { key: 'rateLimited', label: 'Rate Limited', color: '#f97316' },
                { key: 'connectionRefused', label: 'Connection Refused', color: '#b91c1c' },
                { key: 'authErrors', label: 'Auth Errors', color: '#7c3aed' },
                { key: 'clientDisconnects', label: 'Client Disconnects', color: '#6366f1' },
                { key: 'other', label: 'Other', color: '#94a3b8' }
            ];

            errorTypes.forEach(et => {
                const count = errors[et.key] || 0;
                if (count > 0) {
                    labels.push(et.label);
                    data.push(count);
                    colors.push(et.color);
                }
            });

            // Update chart
            STATE.charts.dist.data.labels = labels;
            STATE.charts.dist.data.datasets[0].data = data;
            STATE.charts.dist.data.datasets[0].backgroundColor = colors;
            STATE.charts.dist.update('none');

            // Toggle empty state for distribution chart
            const hasDistData = data.length > 0;
            const distEmptyEl = document.getElementById('distChartEmpty');
            if (distEmptyEl) distEmptyEl.style.display = hasDistData ? 'none' : 'block';
        }

        // Update logs
        function updateLogs(logs) {
            const container = document.getElementById('logsContainer');
            const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;

            container.innerHTML = logs.map(log => {
                const time = formatTimestamp(log.timestamp);
                const level = (log.level || 'INFO').toUpperCase();
                return `
                    <div class="log-entry">
                        <span class="log-time">${time}</span>
                        <span class="log-level ${level}">${level}</span>
                        <span class="log-message">${escapeHtml(log.message || '')}</span>
                    </div>
                `;
            }).join('');

            if (autoScrollLogs && wasAtBottom) {
                container.scrollTop = container.scrollHeight;
            }
        }

        // Control actions
        async function controlAction(action) {
            try {
                const res = await fetch('/control/' + action, { method: 'POST' });
                if (!res.ok) {
                    console.error('Control action ' + action + ' failed:', res.status);
                }
                await fetchStats();
            } catch (err) {
                console.error('Control action failed:', err);
            }
        }

        // Reload keys
        async function reloadKeys() {
            try {
                const res = await fetch('/reload', { method: 'POST' });
                if (!res.ok) {
                    console.error('Reload failed:', res.status);
                }
                await fetchStats();
            } catch (err) {
                console.error('Reload failed:', err);
            }
        }

        // Force circuit state
        async function forceCircuitState(state) {
            if (STATE.selectedKeyIndex === null) return;
            try {
                const res = await fetch(`/control/circuit/${STATE.selectedKeyIndex}/${state}`, { method: 'POST' });
                if (!res.ok) {
                    console.error('Force circuit state failed:', res.status);
                }
                await fetchStats();
            } catch (err) {
                console.error('Force circuit state failed:', err);
            }
        }

        // Reset stats
        async function resetStats() {
            try {
                const res = await fetch('/control/reset-stats', { method: 'POST' });
                if (!res.ok) {
                    console.error('Reset stats failed:', res.status);
                }
                await fetchStats();
            } catch (err) {
                console.error('Reset stats failed:', err);
            }
        }

        // Clear logs
        async function clearLogs() {
            try {
                const res = await fetch('/control/clear-logs', { method: 'POST' });
                if (!res.ok) {
                    console.error('Clear logs failed:', res.status);
                }
                await fetchLogs();
            } catch (err) {
                console.error('Clear logs failed:', err);
            }
        }

        // Utility functions
        function formatUptime(seconds) {
            if (seconds < 60) return seconds + 's';
            if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            return h + 'h ' + m + 'm';
        }

        function formatNumber(num) {
            if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
            return num.toString();
        }

        function updateHealthScoreBadge(stats) {
            const badge = document.getElementById('healthScoreBadge');
            if (!badge) return;

            // Calculate overall health score from key scores
            const keys = stats.keys || [];
            if (keys.length === 0) {
                badge.textContent = '100';
                badge.className = 'health-score-badge excellent';
                return;
            }

            // Average health scores across all keys
            let totalScore = 0;
            let keyCount = 0;
            keys.forEach(key => {
                if (key.healthScore && typeof key.healthScore.total === 'number') {
                    totalScore += key.healthScore.total;
                    keyCount++;
                }
            });

            const avgScore = keyCount > 0 ? Math.round(totalScore / keyCount) : 100;
            badge.textContent = avgScore;

            // Update badge class based on score
            badge.className = 'health-score-badge';
            if (avgScore >= 80) {
                badge.classList.add('excellent');
            } else if (avgScore >= 60) {
                badge.classList.add('good');
            } else if (avgScore >= 40) {
                badge.classList.add('fair');
            } else {
                badge.classList.add('poor');
            }
        }

        // Cleanup function to prevent memory leaks
        function cleanup() {
            // Clear all intervals
            const intervals = [
                'statsIntervalId', 'historyIntervalId', 'logsIntervalId',
                'histogramIntervalId', 'costIntervalId', 'comparisonIntervalId',
                'authIntervalId', 'staleCheckIntervalId', 'requestPollingIntervalId'
            ];

            if (statsIntervalId) { clearInterval(statsIntervalId); statsIntervalId = null; }
            if (historyIntervalId) { clearInterval(historyIntervalId); historyIntervalId = null; }
            if (logsIntervalId) { clearInterval(logsIntervalId); logsIntervalId = null; }
            if (histogramIntervalId) { clearInterval(histogramIntervalId); histogramIntervalId = null; }
            if (costIntervalId) { clearInterval(costIntervalId); costIntervalId = null; }
            if (comparisonIntervalId) { clearInterval(comparisonIntervalId); comparisonIntervalId = null; }
            if (authIntervalId) { clearInterval(authIntervalId); authIntervalId = null; }
            if (staleCheckIntervalId) { clearInterval(staleCheckIntervalId); staleCheckIntervalId = null; }
            if (requestPollingIntervalId) { clearInterval(requestPollingIntervalId); requestPollingIntervalId = null; }

            // Clear timeout
            if (timeRangeChangeTimeout) {
                clearTimeout(timeRangeChangeTimeout);
                timeRangeChangeTimeout = null;
            }

            // Abort pending fetch
            if (historyFetchController) {
                historyFetchController.abort();
                historyFetchController = null;
            }

            // Close SSE EventSource connection
            if (STATE.sse.eventSource) {
                STATE.sse.eventSource.close();
                STATE.sse.eventSource = null;
                STATE.sse.connected = false;
            }

            // Destroy Chart.js instances to free memory
            // Main charts (also stored in STATE.charts)
            if (requestChart) { requestChart.destroy(); requestChart = null; }
            if (latencyChart) { latencyChart.destroy(); latencyChart = null; }
            if (errorChart) { errorChart.destroy(); errorChart = null; }
            if (distChart) { distChart.destroy(); distChart = null; }
            // Routing charts
            if (routingTierChart) { routingTierChart.destroy(); routingTierChart = null; }
            if (routingSourceChart) { routingSourceChart.destroy(); routingSourceChart = null; }
            if (routing429Chart) { routing429Chart.destroy(); routing429Chart = null; }
            // Histogram chart
            if (typeof histogramChart !== 'undefined' && histogramChart) {
                histogramChart.destroy();
                histogramChart = null;
            }
            // Clear STATE.charts references
            if (STATE.charts) {
                STATE.charts.request = null;
                STATE.charts.latency = null;
                STATE.charts.error = null;
                STATE.charts.dist = null;
            }
        }

        // ========== NEW FEATURE FUNCTIONS (#3-#10) ==========

        // Histogram chart reference and state
        let histogramChart = null;
        let currentHistogramRange = '15m';

        // Cost tracking
        async function fetchCostStats() {
            const data = await fetchJSON('/stats/cost');
            if (data) {
                updateCostPanel(data);
                document.getElementById('costPanel').style.display = 'block';
            }
        }

        function updateCostPanel(data) {
            document.getElementById('todayCost').textContent = '$' + (data.cost || 0).toFixed(4);
            document.getElementById('projectedCost').textContent = '$' + (data.projection?.daily?.projected || 0).toFixed(4);
            document.getElementById('monthCost').textContent = '$' + (data.projection?.monthly?.current || 0).toFixed(4);
            document.getElementById('avgCostPerReq').textContent = '$' + (data.avgCostPerRequest || 0).toFixed(6);

            // Show/hide cost empty hint based on whether data exists
            const costHint = document.getElementById('costEmptyHint');
            if (costHint) {
                const hasCostData = (data.cost || 0) > 0;
                costHint.style.display = hasCostData ? 'none' : 'block';
            }

            // Budget progress
            if (data.budget?.limit) {
                document.getElementById('budgetProgress').style.display = 'block';
                const pct = Math.min(100, data.budget.percentUsed || 0);
                const fill = document.getElementById('budgetFill');
                fill.style.width = pct + '%';
                fill.className = 'budget-fill ' + (pct < 50 ? 'ok' : pct < 80 ? 'warning' : 'danger');
                document.getElementById('budgetLabel').textContent = pct + '% of $' + data.budget.limit + ' budget';
            }
        }

        // Latency histogram
        async function fetchHistogram() {
            const data = await fetchJSON('/stats/latency-histogram?range=' + currentHistogramRange);
            if (data) {
                updateHistogram(data);
            }
        }

        function updateHistogram(data) {
            const labels = data.bucketLabels || Object.keys(data.buckets || {});
            const values = Object.values(data.buckets || {});

            if (!histogramChart) {
                const el = document.getElementById('histogramChart');
                if (!el) return;
                const ctx = el.getContext('2d');
                histogramChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Requests',
                            data: values,
                            backgroundColor: 'rgba(6, 182, 212, 0.6)',
                            borderColor: 'rgba(6, 182, 212, 1)',
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: {
                            y: { beginAtZero: true, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
                            x: { ticks: { color: '#94a3b8', maxRotation: 45 }, grid: { display: false } }
                        }
                    }
                });
            } else {
                histogramChart.data.labels = labels;
                histogramChart.data.datasets[0].data = values;
                histogramChart.update();
            }

            // Update stats
            const stats = data.stats || {};
            document.getElementById('histogramCount').textContent = stats.count || 0;
            document.getElementById('histogramAvg').textContent = (stats.avg || 0) + 'ms';
            document.getElementById('histogramP50').textContent = (stats.p50 || 0) + 'ms';
            document.getElementById('histogramP95').textContent = (stats.p95 || 0) + 'ms';
            document.getElementById('histogramP99').textContent = (stats.p99 || 0) + 'ms';
        }

        function setHistogramRange(range) {
            currentHistogramRange = range;
            document.querySelectorAll('.time-range-btn').forEach(btn => {
                btn.classList.toggle('active', btn.textContent === range);
            });
            fetchHistogram();
        }

        // Key comparison
        async function fetchComparison() {
            try {
                const res = await fetch('/compare');
                if (res.ok) {
                    const data = await res.json();
                    updateComparison(data);
                }
            } catch (e) {
                // Silently ignore - comparison endpoint may not exist
            }
        }

        function updateComparison(data) {
            const grid = document.getElementById('comparisonGrid');
            const keys = data.keys || [];

            grid.innerHTML = keys.map((k, i) => {
                const isBest = i === 0;
                const perf = k.normalized?.performance || 0;
                const rel = k.normalized?.reliability || 0;
                const stab = k.normalized?.stability || 0;

                return `
                    <div class="comparison-key ${isBest ? 'best' : ''}">
                        <div class="key-header">
                            <span>K${k.keyIndex}</span>
                            <span class="score">${k.overallScore}</span>
                        </div>
                        <div>
                            <small>Performance <span class="bar-value">${perf}%</span></small>
                            <div class="comparison-bar">
                                <div class="comparison-bar-fill performance" style="width: ${perf}%">${perf >= 30 ? `<span class="bar-text">${perf}%</span>` : ''}</div>
                            </div>
                        </div>
                        <div>
                            <small>Reliability <span class="bar-value">${rel}%</span></small>
                            <div class="comparison-bar">
                                <div class="comparison-bar-fill reliability" style="width: ${rel}%">${rel >= 30 ? `<span class="bar-text">${rel}%</span>` : ''}</div>
                            </div>
                        </div>
                        <div>
                            <small>Stability <span class="bar-value">${stab}%</span></small>
                            <div class="comparison-bar">
                                <div class="comparison-bar-fill stability" style="width: ${stab}%">${stab >= 30 ? `<span class="bar-text">${stab}%</span>` : ''}</div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            // Update insights
            const insightsList = document.getElementById('insightsList');
            const insights = data.insights || [];
            insightsList.innerHTML = insights.map(i => `
                <div class="insight ${i.type}">${i.message}</div>
            `).join('');
        }

        // Initialize
        async function init() {
            // Load user preferences
            loadTheme();
            loadDensity();
            loadTabOrdering();  // Phase 2: Load tab ordering preferences

            // M5: Dock panels are now rendered directly inside #drawerContent server-side.
            // No initPromotedPanels() needed — dockPanelsContainer has been removed.

            loadActiveTab();
            loadActivePage();  // Top-level page navigation
            loadActiveRequestTab();  // Phase 4c: Requests page sub-tabs
            initTimeRangeFromUrl();  // Milestone A: Load time range from URL

            // Initialize UX Improvement Managers
            window.filterManager = new FilterStateManager();
            window.urlManager = new URLStateManager();
            window.searchManager = new GlobalSearchManager();
            window.contextMenuManager = new ContextMenuManager();
            window.progressiveManager = new ProgressiveDisclosureManager();
            window.anomalyManager = new AnomalyDetectionManager();

            // Register keyboard shortcuts
            document.addEventListener('keydown', handleKeyboardShortcuts);

            // Setup event delegation for routing actions (wrapped in error boundary)
            document.addEventListener('click', function(e) {
                const action = e.target.closest('[data-action]');
                if (!action) return;

                const actionType = action.dataset.action;
                const claude = action.dataset.claude;

                errorBoundary.run('click-handler', () => {
                    switch (actionType) {
                        case 'remove-override':
                            removeOverride(claude);
                            break;
                        case 'add-routing-override':
                            addRoutingOverride();
                            break;
                        case 'remove-routing-override':
                            removeRoutingOverride(action.getAttribute('data-key'));
                            break;
                        case 'run-routing-test':
                            runRoutingTest();
                            break;
                        case 'run-explain':
                            runExplain();
                            break;
                        case 'save-tier':
                            saveTierConfig(action.getAttribute('data-tier'));
                            break;
                        case 'add-routing-rule':
                            addRoutingRule();
                            break;
                        case 'remove-routing-rule':
                            removeRoutingRule(parseInt(action.getAttribute('data-rule-index'), 10));
                            break;
                        case 'reset-model-routing':
                            resetModelRouting();
                            break;
                        case 'copy-routing-json':
                            copyRoutingJson();
                            break;
                        case 'export-routing-json':
                            exportRoutingJson();
                            break;
                        case 'reload-page':
                            location.reload();
                            break;
                        case 'dismiss-banner': {
                            const targetId = action.dataset.target;
                            if (targetId) {
                                const el = document.getElementById(targetId);
                                if (el) el.style.display = 'none';
                            }
                            break;
                        }
                        case 'noop':
                            e.preventDefault();
                            break;
                        case 'close-toast':
                            action.closest('.toast')?.remove();
                            break;
                        // Debug-only throw path for testing error boundary (guard with debug mode check)
                        case 'debug-throw':
                            if (window.location.search.includes('debug=1')) {
                                throw new Error('Debug test error');
                            }
                            break;
                    }
                });
            });

            initCharts();
            initARIA();  // Phase 5: Initialize ARIA attributes
            await Promise.all([fetchStats(), fetchHistory(), fetchLogs(), fetchTenants()]);
            statsIntervalId = setInterval(fetchStats, 2000);
            // Use TIME_RANGES for initial poll interval based on current time range setting
            historyIntervalId = setInterval(fetchHistory, TIME_RANGES[STATE.settings.timeRange].pollInterval);
            logsIntervalId = setInterval(fetchLogs, 2000);

            // Connect to request stream
            connectRequestStream();

            // Initialize Week 2 UX features
            initFilterListeners();

            // Initialize auth (Milestone 1)
            await fetchAuthStatus();
            loadStoredToken();

            // Initialize new features
            fetchHistogram();
            fetchCostStats();
            fetchComparison();
            await fetchModels();  // Fetch available models FIRST - needed for routing config
            fetchModelRouting();

            // Restore persisted routing tab selection
            const savedRoutingTab = localStorage.getItem('dashboard-routing-tab');
            if (savedRoutingTab) {
                switchRoutingTab(savedRoutingTab);
            }

            histogramIntervalId = setInterval(fetchHistogram, 10000);
            costIntervalId = setInterval(fetchCostStats, 10000);
            comparisonIntervalId = setInterval(fetchComparison, 15000);
            authIntervalId = setInterval(fetchAuthStatus, 30000);  // Check auth status every 30s
        }

        document.addEventListener('DOMContentLoaded', init);

        // Clean up on page unload to prevent memory leaks
        window.addEventListener('beforeunload', cleanup);
        window.addEventListener('pagehide', cleanup);

        // ========== KEY OVERRIDE MODAL FUNCTIONS ==========

        let currentKeyOverrides = { useGlobal: true, overrides: {} };
        let currentEditingKeyIndex = null;

        // Open key override modal
        // Updated: Reads from cached routing data instead of deprecated /model-mapping/keys endpoint
        function openKeyOverrideModal(keyIndex) {
            currentEditingKeyIndex = keyIndex;

            try {
                if (!STATE.routingData || !STATE.routingData.overrides) {
                    showToast('Routing data not available. Please refresh the page.', 'error');
                    return;
                }

                const overrides = STATE.routingData.overrides;
                const keyOverrides = overrides[keyIndex] || {};

                // Build data structure similar to what the deprecated endpoint returned
                const data = {
                    useGlobal: Object.keys(keyOverrides).length === 0,
                    overrides: keyOverrides
                };

                currentKeyOverrides = data;

                // Update modal UI
                document.getElementById('keyOverrideKeyName').textContent = 'Key ' + (keyIndex + 1);
                document.getElementById('useGlobalMapping').checked = data.useGlobal;
                document.getElementById('addOverrideForm').style.display = data.useGlobal ? 'none' : 'flex';

                renderOverrideList();

                // Show modal
                document.getElementById('keyOverrideModal').classList.add('visible');
            } catch (err) {
                console.error('Error loading key overrides:', err);
                showToast('Failed to load key overrides', 'error');
            }
        }

        // Close key override modal
        function closeKeyOverrideModal(event) {
            if (event && event.target && event.target.id !== 'keyOverrideModal' && event.key !== 'Escape') {
                return;
            }
            document.getElementById('keyOverrideModal').classList.remove('visible');
            currentEditingKeyIndex = null;
        }

        // Toggle use global mapping
        function toggleUseGlobalMapping() {
            const useGlobal = document.getElementById('useGlobalMapping').checked;
            currentKeyOverrides.useGlobal = useGlobal;
            document.getElementById('addOverrideForm').style.display = useGlobal ? 'none' : 'flex';
        }

        // Render override list
        function renderOverrideList() {
            const listEl = document.getElementById('overrideList');
            const overrides = currentKeyOverrides.overrides || {};
            const overrideKeys = Object.keys(overrides);

            if (overrideKeys.length === 0) {
                listEl.innerHTML = renderEmptyState('No overrides configured', { icon: '—' });
                return;
            }

            listEl.innerHTML = overrideKeys.map(claude => {
                const glm = overrides[claude];
                return `
                    <div class="override-item">
                        <div class="override-models">
                            <span class="mapping-model claude">${escapeHtml(claude)}</span>
                            <span class="mapping-arrow">→</span>
                            <span class="mapping-model glm">${escapeHtml(glm)}</span>
                        </div>
                        <button class="override-remove" data-action="remove-override" data-claude="${escapeHtml(claude)}" title="Remove override">&times;</button>
                    </div>
                `;
            }).join('');
        }

        // Add override
        function addOverride() {
            const claudeInput = document.getElementById('newClaudeModel');
            const glmInput = document.getElementById('newGlmModel');

            const claude = claudeInput.value.trim();
            const glm = glmInput.value.trim();

            if (!claude || !glm) {
                showToast('Please enter both model names', 'warning');
                return;
            }

            if (!currentKeyOverrides.overrides) {
                currentKeyOverrides.overrides = {};
            }

            currentKeyOverrides.overrides[claude] = glm;
            renderOverrideList();

            claudeInput.value = '';
            glmInput.value = '';
        }

        // Remove override
        function removeOverride(claude) {
            if (currentKeyOverrides.overrides) {
                delete currentKeyOverrides.overrides[claude];
                renderOverrideList();
            }
        }

        // Save key overrides
        // Updated: Uses PUT /model-routing instead of deprecated /model-mapping/keys endpoint
        async function saveKeyOverrides() {
            if (currentEditingKeyIndex === null) return;

            try {
                if (!STATE.routingData) {
                    showToast('Routing data not available', 'error');
                    return;
                }

                // Build updated overrides structure
                const currentOverrides = STATE.routingData.overrides || {};
                const updatedOverrides = { ...currentOverrides };

                // Update overrides for the current key
                if (currentKeyOverrides.useGlobal || Object.keys(currentKeyOverrides.overrides || {}).length === 0) {
                    // Remove key-specific overrides (use global routing)
                    delete updatedOverrides[currentEditingKeyIndex];
                } else {
                    // Set key-specific overrides
                    updatedOverrides[currentEditingKeyIndex] = currentKeyOverrides.overrides;
                }

                // Prepare payload for PUT /model-routing
                // Include existing routing config plus updated overrides
                const payload = {
                    ...STATE.routingData.config,
                    overrides: updatedOverrides
                };

                const res = await fetch('/model-routing', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    showToast('Failed to save: ' + (errData.error || res.statusText), 'error');
                    return;
                }

                const result = await res.json();

                closeKeyOverrideModal();

                // Check if changes were persisted
                if (result.persisted === true) {
                    showToast('Key overrides saved and persisted', 'success');
                } else {
                    showToast('Key overrides saved (runtime only)', 'warning');
                }

                // Refresh routing data
                await fetchModelRouting();

                // Refresh key details to show override count
                if (STATE.selectedKeyIndex !== null && STATE.selectedKeyIndex === currentEditingKeyIndex) {
                    selectKey(STATE.selectedKeyIndex);
                }
            } catch (err) {
                console.error('Error saving key overrides:', err);
                showToast('Failed to save key overrides', 'error');
            }
        }

        // ========== MODEL ROUTING FUNCTIONS ==========

        let modelRoutingData = null;
        let routingCooldownInterval = null;

        async function fetchModelRouting() {
            try {
                const res = await fetch('/model-routing');
                if (!res.ok) return;
                modelRoutingData = await res.json();
                STATE.routingData = modelRoutingData;  // Cache routing data for key overrides
                renderModelRouting();
            } catch (err) {
                console.error('Error fetching model routing:', err);
                // Categorize error for appropriate display
                const category = categorizeError(err);
                const message = getErrorMessage(err, category);
                const isRetryable = ['network', 'timeout', 'server', 'unknown'].includes(category);

                // Show error state in routing panel
                const routingPanel = document.getElementById('routingPanel');
                if (routingPanel) {
                    routingPanel.innerHTML = renderErrorState(message, { retryable: isRetryable });
                }
            }
        }

        function renderModelRouting() {
            if (!modelRoutingData) return;
            const data = modelRoutingData;

            // Status badge
            const badge = document.getElementById('routingStatusBadge');
            if (badge) {
                badge.textContent = data.enabled ? 'Enabled' : 'Disabled';
                badge.className = 'status-badge ' + (data.enabled ? 'enabled' : 'disabled');
            }

            // Toggle between disabled CTA and full tier builder
            const ctaEl = document.getElementById('routingDisabledCTA');
            const enabledContentEl = document.getElementById('routingEnabledContent');
            const liveFlowEl = document.getElementById('liveFlowContainer');
            if (ctaEl && enabledContentEl) {
                if (data.enabled) {
                    ctaEl.style.display = 'none';
                    enabledContentEl.style.display = '';
                    if (liveFlowEl) liveFlowEl.style.display = '';
                } else {
                    ctaEl.style.display = '';
                    enabledContentEl.style.display = 'none';
                    if (liveFlowEl) liveFlowEl.style.display = 'none';
                }
            }

            // Update toggle button text
            const toggleBtn = document.getElementById('routingToggleBtn');
            if (toggleBtn) {
                toggleBtn.textContent = data.enabled ? 'Disable' : 'Enable';
                toggleBtn.className = 'btn btn-small routing-toggle-btn' + (data.enabled ? ' btn-secondary' : ' btn-primary');
            }

            // Persistence badge
            const persistBadge = document.getElementById('routing-persist-badge');
            if (persistBadge) {
                const p = data.persistence;
                if (p && p.enabled) {
                    persistBadge.className = 'persist-badge badge-success';
                    persistBadge.textContent = 'Persisted';
                    persistBadge.title = p.lastSavedAt ? 'Last saved: ' + formatTimestamp(p.lastSavedAt, {full: true}) : 'No saves yet';
                } else {
                    persistBadge.className = 'persist-badge badge-warning';
                    persistBadge.textContent = 'Runtime Only';
                    persistBadge.title = 'Changes will be lost on restart';
                }
            }

            // Persistence warning banner
            const persistWarning = document.getElementById('routing-persist-warning');
            if (persistWarning) {
                const p = data.persistence;
                if (p && p.enabled) {
                    persistWarning.style.display = 'none';
                } else {
                    persistWarning.style.display = 'block';
                }
            }

            // Stats — hide grid when routing is disabled and no data
            const stats = data.stats || { byTier: {}, bySource: {}, total: 0 };
            const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            const statsGrid = document.getElementById('routingStatsGrid');
            if (statsGrid) {
                if (!data.enabled && stats.total === 0) {
                    statsGrid.style.display = 'none';
                } else {
                    statsGrid.style.display = '';
                }
            }
            // Show/hide routing advanced tabs based on routing state
            const routingTabsSection = document.getElementById('routingTabsSection');
            if (routingTabsSection) {
                routingTabsSection.style.display = data.enabled ? '' : 'none';
            }
            setVal('routingTotal', stats.total);
            setVal('routingLight', stats.byTier.light || 0);
            setVal('routingMedium', stats.byTier.medium || 0);
            setVal('routingHeavy', stats.byTier.heavy || 0);
            setVal('routingFailovers', stats.bySource.failover || 0);
            setVal('routingPools', stats.bySource.pool || 0);
            setVal('routingGlm5Eligible', stats.glm5EligibleTotal || 0);
            setVal('routingGlm5Applied', stats.glm5PreferenceApplied || 0);
            const overflowByCause = stats.contextOverflowByCause || {};
            setVal('routingOverflowGenuine', overflowByCause.genuine || 0);
            setVal('routingOverflowTransient', overflowByCause.transient_unavailable || 0);

            // Tier Builder (drag-and-drop)
            if (!window._tierBuilder) {
                window._tierBuilder = new TierBuilder();
            }
            const availableModels = getAvailableModels();
            window._tierBuilder.render(data, STATE.modelsData, availableModels);
            window._tierBuilder.updateShadowBadges(data?.config);

            // Fallback chain visualization
            renderFallbackChains(data);

            // Pool status visualization
            renderPoolStatus(data);
            startPoolPolling();

            // Routing rules
            renderRoutingRules(data);

            // Per-model usage
            renderModelUsage();

            // Cooldowns table
            renderRoutingCooldowns();

            // Update TierBuilder with cooldown data
            if (window._tierBuilder && data.cooldowns) {
                for (const [modelId, cd] of Object.entries(data.cooldowns)) {
                    window._tierBuilder._updateModelCards(
                        modelId,
                        0,  // inFlight not in cooldown data
                        0,  // maxConcurrency not in cooldown data
                        cd.remainingMs || 0
                    );
                }
            }

            // Overrides table
            renderRoutingOverrides();

            // Update routing observability distribution charts
            updateRoutingDistributionCharts();

            // Update flow diagram highlights based on routing state
            updateFlowDiagram(data.enabled);

            // Update routing status indicators
            const routingPill = document.getElementById('routingStatusPill');
            if (routingPill) {
                routingPill.textContent = 'Routing: ' + (data.enabled ? 'On' : 'Off');
                if (data.enabled) {
                    routingPill.classList.add('active');
                } else {
                    routingPill.classList.remove('active');
                }
            }
            const activeStatus = document.getElementById('activeSystemStatus');
            if (activeStatus) {
                activeStatus.textContent = 'Active system: ' + (data.enabled ? 'Routing' : 'None');
            }
        }

        // ========== LIVE FLOW VISUALIZATION (D3.js) ==========
        class LiveFlowViz {
            constructor(canvasId) {
                this.canvas = document.getElementById(canvasId);
                this.emptyState = document.getElementById('liveFlowEmpty');
                this.statusEl = document.getElementById('liveFlowStatus');
                this.enabled = false;
                this.poolData = null;
                this.particles = [];
                this.particleId = 0;
                this.rafId = null;
                this.svg = null;
                this.width = 0;
                this.height = 0;

                // Particle cap (D3-02)
                this.MAX_PARTICLES = 25;
                this.overflowCount = 0;

                // prefers-reduced-motion (D3-03)
                this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                this._motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
                this._motionHandler = (e) => { this.reducedMotion = e.matches; };
                this._motionQuery.addEventListener('change', this._motionHandler);

                // Page Visibility (D3-04)
                this._visHandler = () => this._onVisibilityChange();
                document.addEventListener('visibilitychange', this._visHandler);

                // SSE listener for pool-status (will be attached when EventSource is ready)
                this._sseHandler = (e) => this._onPoolStatus(e);
                this._sseAttached = false;

                // Fallback polling state
                this._usePolling = false;
                this._pollTimer = null;

                // Initialize SVG
                this._initSvg();
            }

            /** Initialize the D3 SVG element inside the canvas container */
            _initSvg() {
                if (!this.canvas || !FEATURES.d3) return;
                // Clear any existing content (except empty state)
                d3.select(this.canvas).selectAll('svg').remove();

                const rect = this.canvas.getBoundingClientRect();
                this.width = Math.max(rect.width || 580, 400);
                this.height = 150;

                this.svg = d3.select(this.canvas)
                    .append('svg')
                    .attr('width', '100%')
                    .attr('height', this.height)
                    .attr('viewBox', `0 0 ${this.width} ${this.height}`)
                    .attr('preserveAspectRatio', 'xMidYMid meet');

                // Layer groups for z-ordering
                this.bgLayer = this.svg.append('g').attr('class', 'bg-layer');
                this.laneLayer = this.svg.append('g').attr('class', 'lane-layer');
                this.particleLayer = this.svg.append('g').attr('class', 'particle-layer');
                this.labelLayer = this.svg.append('g').attr('class', 'label-layer');
            }

            /** Set routing enabled/disabled state */
            setEnabled(enabled) {
                this.enabled = enabled;
                if (this.emptyState) {
                    this.emptyState.style.display = enabled ? 'none' : 'flex';
                }
                if (this.svg) {
                    this.svg.style('display', enabled ? 'block' : 'none');
                }
                const legend = document.getElementById('liveFlowLegend');
                if (legend) {
                    legend.style.display = enabled ? 'flex' : 'none';
                }

                if (enabled) {
                    this._attachSSE();
                }
            }

            /** Attach SSE listener for pool-status events */
            _attachSSE() {
                if (this._sseAttached) return;
                const es = STATE.sse.eventSource;
                if (es && es.readyState !== 2) { // 2 = CLOSED
                    es.addEventListener('pool-status', this._sseHandler);
                    this._sseAttached = true;
                    this._setStatus('connected');
                } else {
                    // SSE not available, start fallback polling (D3-05)
                    this._startFallbackPolling();
                }
            }

            /** Handle incoming pool-status SSE event */
            _onPoolStatus(e) {
                try {
                    const data = JSON.parse(e.data);
                    this.poolData = data.pools || data;
                    this._render();

                    // Also update the existing pool status bars if modelRoutingData exists
                    if (typeof modelRoutingData !== 'undefined' && modelRoutingData && data.pools) {
                        modelRoutingData.pools = data.pools;
                        if (typeof renderPoolStatus === 'function') {
                            renderPoolStatus(modelRoutingData);
                        }
                    }

                    // Update TierBuilder concurrency bars from SSE pool-status
                    if (window._tierBuilder && data.pools) {
                        window._tierBuilder.updatePoolStatus(data.pools);
                    }
                } catch (err) {
                    // Parse error, ignore
                }
            }

            /** Start fallback polling to /model-routing/pools (D3-05) */
            _startFallbackPolling() {
                if (this._pollTimer) return;
                this._usePolling = true;
                this._setStatus('polling');

                this._pollTimer = setInterval(async () => {
                    if (!this.enabled) return;
                    try {
                        const res = await fetch('/model-routing/pools');
                        if (res.ok) {
                            const pools = await res.json();
                            this.poolData = pools;
                            this._render();
                        }
                    } catch (_e) { /* ignore poll errors */ }
                }, 3000);
            }

            /** Stop fallback polling */
            _stopFallbackPolling() {
                if (this._pollTimer) {
                    clearInterval(this._pollTimer);
                    this._pollTimer = null;
                }
                this._usePolling = false;
            }

            /** Update connection status indicator */
            _setStatus(status) {
                if (!this.statusEl) return;
                this.statusEl.className = 'live-flow-status ' + status;
                const labels = { connected: 'Live', polling: 'Polling', error: 'Disconnected' };
                this.statusEl.textContent = labels[status] || status;
            }

            /** Render the swim-lane visualization from current poolData */
            _render() {
                if (!this.svg || !this.poolData || !this.enabled) return;

                const tiers = Object.entries(this.poolData);
                if (tiers.length === 0) return;

                // Layout constants
                const margin = { top: 20, right: 20, bottom: 10, left: 70 };
                const laneH = 30;
                const laneGap = 8;
                const modelW = 80;
                const modelGap = 10;
                const contentW = this.width - margin.left - margin.right;

                // Request node (left side)
                this._renderRequestNode(margin);

                // Swim lanes (one per tier)
                tiers.forEach(([tierName, models], i) => {
                    const y = margin.top + i * (laneH + laneGap);

                    // Lane background
                    const lanes = this.laneLayer.selectAll(`.lane-bg-${tierName}`)
                        .data([tierName]);
                    lanes.enter()
                        .append('rect')
                        .attr('class', `swim-lane-bg lane-bg-${tierName}`)
                        .merge(lanes)
                        .attr('x', margin.left)
                        .attr('y', y)
                        .attr('width', contentW)
                        .attr('height', laneH);

                    // Lane label
                    const labels = this.labelLayer.selectAll(`.lane-label-${tierName}`)
                        .data([tierName]);
                    labels.enter()
                        .append('text')
                        .attr('class', `swim-lane-label lane-label-${tierName}`)
                        .merge(labels)
                        .attr('x', margin.left - 8)
                        .attr('y', y + laneH / 2)
                        .attr('text-anchor', 'end')
                        .attr('dominant-baseline', 'central')
                        .text(tierName.charAt(0).toUpperCase() + tierName.slice(1));

                    // Model boxes inside lane
                    const modelData = Array.isArray(models) ? models : [];
                    const modelSel = this.laneLayer.selectAll(`.model-${tierName}`)
                        .data(modelData, d => d.model);

                    // Enter
                    const entered = modelSel.enter()
                        .append('g')
                        .attr('class', `model-${tierName}`);
                    entered.append('rect')
                        .attr('class', `swim-lane-model tier-${tierName}`)
                        .attr('height', laneH - 6)
                        .attr('width', modelW);
                    entered.append('text')
                        .attr('class', 'swim-lane-model-label');

                    // Update (enter + existing)
                    const merged = entered.merge(modelSel);
                    merged.attr('transform', (d, j) => {
                        const x = margin.left + 10 + j * (modelW + modelGap);
                        return `translate(${x}, ${y + 3})`;
                    });
                    merged.select('rect')
                        .attr('width', modelW)
                        .attr('height', laneH - 6);
                    merged.select('text')
                        .attr('x', modelW / 2)
                        .attr('y', (laneH - 6) / 2)
                        .text(d => {
                            const name = d.model || '';
                            // Truncate long model names
                            return name.length > 12 ? name.slice(0, 11) + '\u2026' : name;
                        });

                    // Exit
                    modelSel.exit().remove();
                });

                // Spawn particles if not reduced motion
                if (!this.reducedMotion) {
                    this._spawnParticles(tiers, margin, laneH, laneGap);
                }
            }

            /** Render the request entry node on the left */
            _renderRequestNode(margin) {
                const existing = this.bgLayer.selectAll('.request-node').data([1]);
                const g = existing.enter().append('g').attr('class', 'request-node');
                g.append('circle')
                    .attr('cx', 25)
                    .attr('cy', margin.top + 20)
                    .attr('r', 14)
                    .attr('fill', 'var(--bg-card)')
                    .attr('stroke', 'var(--border)')
                    .attr('stroke-width', 1.5);
                g.append('text')
                    .attr('x', 25)
                    .attr('y', margin.top + 24)
                    .attr('text-anchor', 'middle')
                    .attr('font-size', '8px')
                    .attr('fill', 'var(--text-primary)')
                    .text('Req');

                // Arrow from request node to lanes
                const arrowData = this.bgLayer.selectAll('.request-arrow').data([1]);
                arrowData.enter().append('line')
                    .attr('class', 'request-arrow')
                    .attr('x1', 39)
                    .attr('y1', margin.top + 20)
                    .attr('x2', margin.left)
                    .attr('y2', margin.top + 20)
                    .attr('stroke', 'var(--border)')
                    .attr('stroke-width', 1)
                    .attr('stroke-dasharray', '3,3');
            }

            /** Spawn animated particles flowing through lanes (D3-02) */
            _spawnParticles(tiers, margin, laneH, laneGap) {
                // Remove particles exceeding cap
                while (this.particles.length >= this.MAX_PARTICLES) {
                    this.particles.shift();
                }

                // Determine which tier gets a particle (based on in-flight counts)
                const totalInFlight = tiers.reduce((sum, [, models]) => {
                    return sum + (Array.isArray(models) ? models.reduce((s, m) => s + (m.inFlight || 0), 0) : 0);
                }, 0);

                if (totalInFlight === 0) {
                    this.overflowCount = 0;
                    this._updateParticleCounter();
                    return;
                }

                // Calculate overflow
                this.overflowCount = Math.max(0, totalInFlight - this.MAX_PARTICLES);
                this._updateParticleCounter();

                // Add a few particles per render cycle (throttled)
                const toAdd = Math.min(3, this.MAX_PARTICLES - this.particles.length);
                for (let i = 0; i < toAdd; i++) {
                    // Weighted random tier selection by in-flight
                    let r = Math.random() * totalInFlight;
                    let selectedTier = null;
                    let tierIndex = 0;
                    for (const [tierName, models] of tiers) {
                        const tierInFlight = Array.isArray(models) ? models.reduce((s, m) => s + (m.inFlight || 0), 0) : 0;
                        r -= tierInFlight;
                        if (r <= 0) {
                            selectedTier = tierName;
                            break;
                        }
                        tierIndex++;
                    }
                    if (!selectedTier) {
                        selectedTier = tiers[0][0];
                        tierIndex = 0;
                    }

                    const y = margin.top + tierIndex * (laneH + laneGap) + laneH / 2;
                    this.particles.push({
                        id: ++this.particleId,
                        tier: selectedTier,
                        x: margin.left,
                        y: y,
                        targetX: margin.left + 10 + Math.random() * 200,
                        speed: 1 + Math.random() * 2
                    });
                }

                // Animate particles
                if (!this.rafId && !document.hidden) {
                    this._animateParticles();
                }
            }

            /** requestAnimationFrame loop for particle animation (D3-04) */
            _animateParticles() {
                if (this.reducedMotion || document.hidden) {
                    this.rafId = null;
                    return;
                }

                // Update positions
                this.particles = this.particles.filter(p => {
                    p.x += p.speed;
                    return p.x < this.width - 20; // Remove when offscreen
                });

                // D3 data join for particles
                const circles = this.particleLayer.selectAll('.flow-particle')
                    .data(this.particles, d => d.id);

                circles.enter()
                    .append('circle')
                    .attr('class', d => `flow-particle tier-${d.tier}`)
                    .attr('r', 3)
                    .merge(circles)
                    .attr('cx', d => d.x)
                    .attr('cy', d => d.y);

                circles.exit().remove();

                if (this.particles.length > 0) {
                    this.rafId = requestAnimationFrame(() => this._animateParticles());
                } else {
                    this.rafId = null;
                }
            }

            /** Update the aggregated particle counter (D3-02) */
            _updateParticleCounter() {
                const counterSel = this.labelLayer.selectAll('.particle-counter').data(
                    this.overflowCount > 0 ? [this.overflowCount] : []
                );
                counterSel.enter()
                    .append('text')
                    .attr('class', 'particle-counter')
                    .merge(counterSel)
                    .attr('x', this.width - 30)
                    .attr('y', 12)
                    .text(d => `+${d} more`);
                counterSel.exit().remove();
            }

            /** Handle visibility change (D3-04) */
            _onVisibilityChange() {
                if (document.hidden) {
                    // Pause RAF
                    if (this.rafId) {
                        cancelAnimationFrame(this.rafId);
                        this.rafId = null;
                    }
                } else {
                    // Resume if we have particles
                    if (this.particles.length > 0 && !this.reducedMotion) {
                        this._animateParticles();
                    }
                }
            }

            /** Clean up all resources */
            destroy() {
                // Remove SSE listener
                const es = STATE.sse.eventSource;
                if (es && this._sseAttached) {
                    es.removeEventListener('pool-status', this._sseHandler);
                    this._sseAttached = false;
                }

                // Stop polling
                this._stopFallbackPolling();

                // Cancel RAF
                if (this.rafId) {
                    cancelAnimationFrame(this.rafId);
                    this.rafId = null;
                }

                // Remove event listeners
                document.removeEventListener('visibilitychange', this._visHandler);
                this._motionQuery.removeEventListener('change', this._motionHandler);

                // Remove SVG
                if (this.canvas) {
                    d3.select(this.canvas).selectAll('svg').remove();
                }

                window._liveFlowViz = null;
            }
        }

        function updateFlowDiagram(routingEnabled) {
            // LiveFlowViz replaces the static SVG flowchart (Phase 4: D3-01)
            if (!window._liveFlowViz) {
                if (typeof d3 !== 'undefined') {
                    window._liveFlowViz = new LiveFlowViz('liveFlowCanvas');
                }
            }
            if (window._liveFlowViz) {
                window._liveFlowViz.setEnabled(routingEnabled);
            }
        }

        function renderRoutingCooldowns() {
            const cooldownBody = document.getElementById('routingCooldownBody');
            if (!cooldownBody || !modelRoutingData) return;
            const cooldowns = modelRoutingData.cooldowns || {};
            const entries = Object.entries(cooldowns);
            if (entries.length === 0) {
                cooldownBody.innerHTML = '<tr><td colspan="3" style="color: var(--text-secondary);">None</td></tr>';
                return;
            }
            cooldownBody.innerHTML = entries.map(([model, info]) =>
                '<tr' + (info.burstDampened ? ' style="opacity:0.7"' : '') + '>' +
                '<td>' + escapeHtml(model) + (info.burstDampened ? ' <span style="color:var(--warning);font-size:0.7rem;">(burst)</span>' : '') + '</td>' +
                '<td>' + (info.remainingMs / 1000).toFixed(1) + 's</td>' +
                '<td>' + info.count + '</td>' +
                '</tr>'
            ).join('');
        }

        function renderRoutingOverrides() {
            const overrideBody = document.getElementById('routingOverrideBody');
            if (!overrideBody || !modelRoutingData) return;
            const overrides = modelRoutingData.overrides || {};
            const entries = Object.entries(overrides);
            if (entries.length === 0) {
                overrideBody.innerHTML = '<tr><td colspan="3" style="color: var(--text-secondary);">None</td></tr>';
                return;
            }
            overrideBody.innerHTML = entries.map(([key, model]) =>
                '<tr>' +
                '<td>' + escapeHtml(key) + '</td>' +
                '<td>' + escapeHtml(model) + '</td>' +
                '<td><button class="btn btn-danger btn-small" data-action="remove-routing-override" data-key="' + escapeHtml(key) + '">Remove</button></td>' +
                '</tr>'
            ).join('');
        }

        async function addRoutingOverride() {
            const keyEl = document.getElementById('routingOverrideKey');
            const modelEl = document.getElementById('routingOverrideModel');
            if (!keyEl || !modelEl) return;
            const key = keyEl.value.trim();
            const model = modelEl.value.trim();
            if (!key || !model) {
                showToast('Key and model are required', 'error');
                return;
            }
            try {
                const res = await fetch('/model-routing/overrides', {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ key, model })
                });
                if (res.ok) {
                    const result = await res.json().catch(() => ({}));
                    keyEl.value = '';
                    modelEl.value = '';
                    if (result.warning === 'runtime_only_change') {
                        showToast('Override added (runtime only — not persisted to disk)', 'warning');
                    } else if (result.persisted === true) {
                        showToast('Override added and persisted to disk', 'success');
                    } else {
                        showToast('Override added', 'success');
                    }
                    fetchModelRouting();
                } else {
                    const data = await res.json();
                    showToast(data.error || 'Failed to add override', 'error');
                }
            } catch (err) {
                showToast('Failed to add override', 'error');
            }
        }

        async function removeRoutingOverride(key) {
            try {
                const res = await fetch('/model-routing/overrides', {
                    method: 'DELETE',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ key })
                });
                if (res.ok) {
                    const result = await res.json().catch(() => ({}));
                    if (result.warning === 'runtime_only_change') {
                        showToast('Override removed (runtime only — not persisted to disk)', 'warning');
                    } else if (result.persisted === true) {
                        showToast('Override removed and persisted to disk', 'success');
                    } else {
                        showToast('Override removed', 'success');
                    }
                    fetchModelRouting();
                } else {
                    showToast('Failed to remove override', 'error');
                }
            } catch (err) {
                showToast('Failed to remove override', 'error');
            }
        }

        // ========== FALLBACK CHAIN VISUALIZATION ==========
        function renderFallbackChains(data) {
            const container = document.getElementById('fallbackChainsViz');
            if (!container) return;
            if (!data?.config?.tiers) {
                container.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 12px;">No fallback chains configured</div>';
                return;
            }

            const cooldowns = data.cooldowns || {};
            const tiers = data.config.tiers;

            // Helper to get display name and tier badge class
            const getModelInfo = (modelId) => {
                const modelData = STATE.modelsData && STATE.modelsData[modelId];
                const displayName = modelData && modelData.displayName ? modelData.displayName : modelId;
                const tier = modelData && modelData.tier ? modelData.tier.toUpperCase() : '';
                return { displayName, tier };
            };

            container.innerHTML = Object.entries(tiers).map(([name, cfg]) => {
                const target = cfg.targetModel || '?';
                const fallbacks = Array.isArray(cfg.fallbackModels) ? cfg.fallbackModels : (cfg.failoverModel ? [cfg.failoverModel] : []);

                const nodes = [target, ...fallbacks];
                const nodesHtml = nodes.map((model, i) => {
                    const cd = cooldowns[model];
                    const isCooled = cd && cd.remainingMs > 0;
                    const cls = i === 0 ? 'primary' : (isCooled ? 'cooled' : 'available');
                    const info = getModelInfo(model);
                    const tierBadgeClass = 'tier-badge-' + (info.tier ? info.tier.toLowerCase() : 'unknown');

                    // Triple-coded status: icon + text + color
                    let statusHtml = '';
                    if (isCooled) {
                        statusHtml = '<span class="chain-status chain-status-cooled" title="Cooled down - rate limited">' +
                            '<span aria-hidden="true">⚡</span> ' +
                            '<span class="visually-hidden">Cooled down, </span>' +
                            (cd.remainingMs / 1000).toFixed(0) + 's' +
                            '</span>';
                    } else if (i > 0) {
                        statusHtml = '<span class="chain-status chain-status-available" title="Available">' +
                            '<span aria-hidden="true">✓</span>' +
                            '<span class="visually-hidden">Available</span>' +
                            '</span>';
                    }

                    return '<span class="chain-node ' + cls + '">' +
                        '<span class="chain-model-name">' + escapeHtml(info.displayName) + '</span>' +
                        '<span class="tier-badge ' + tierBadgeClass + '">' + (info.tier || '?') + '</span>' +
                        statusHtml +
                        '</span>';
                }).join('<span class="chain-arrow" aria-hidden="true">→</span>');

                return '<div class="fallback-chain-row" role="group" aria-label="' + escapeHtml(name) + ' tier fallback chain">' +
                    '<span class="fallback-chain-label">' + escapeHtml(name) + '</span>' +
                    nodesHtml +
                    '</div>';
            }).join('');
        }

        // ========== POOL STATUS VISUALIZATION ==========
        function renderPoolStatus(data) {
            const section = document.getElementById('modelPoolsSection');
            const container = document.getElementById('modelPoolsViz');
            if (!section || !container) return;

            const pools = data?.pools;
            if (!pools || Object.keys(pools).length === 0) {
                section.style.display = 'none';
                return;
            }

            section.style.display = 'block';

            const getModelInfo = (modelId) => {
                const modelData = STATE.modelsData && STATE.modelsData[modelId];
                const displayName = modelData && modelData.displayName ? modelData.displayName : modelId;
                return displayName;
            };

            container.innerHTML = Object.entries(pools).map(([tier, models]) => {
                const totalSlots = models.reduce((sum, m) => sum + m.maxConcurrency, 0);
                const totalInFlight = models.reduce((sum, m) => sum + m.inFlight, 0);
                const utilPct = totalSlots > 0 ? Math.round((totalInFlight / totalSlots) * 100) : 0;

                const modelsHtml = models.map(m => {
                    const pct = m.maxConcurrency > 0 ? Math.round((m.inFlight / m.maxConcurrency) * 100) : 0;
                    const barClass = m.cooldownMs > 0 ? 'pool-bar-cooled' : (pct >= 80 ? 'pool-bar-high' : (pct >= 50 ? 'pool-bar-medium' : 'pool-bar-low'));
                    const displayName = getModelInfo(m.model);
                    const valueText = m.inFlight + '/' + m.maxConcurrency;
                    const showInline = pct >= 25;

                    return '<div class="pool-model-row">' +
                        '<span class="pool-model-name">' + escapeHtml(displayName) + '</span>' +
                        '<div class="pool-bar-track">' +
                            '<div class="pool-bar-fill ' + barClass + '" style="width: ' + pct + '%;">' +
                                (showInline ? '<span class="pool-bar-text">' + valueText + '</span>' : '') +
                            '</div>' +
                            (!showInline ? '<span class="pool-bar-outer">' + valueText + '</span>' : '') +
                        '</div>' +
                        (m.cooldownMs > 0 ? '<span class="pool-model-cooldown" title="Cooled down">' + Math.ceil(m.cooldownMs / 1000) + 's</span>' : '') +
                        '</div>';
                }).join('');

                return '<div class="pool-tier-group">' +
                    '<div class="pool-tier-header">' +
                        '<span class="pool-tier-name">' + escapeHtml(tier) + '</span>' +
                        '<span class="pool-tier-slots">' + totalSlots + ' slots</span>' +
                        '<span class="pool-tier-util">' + utilPct + '%</span>' +
                    '</div>' +
                    modelsHtml +
                    '</div>';
            }).join('');
        }

        // Pool status polling (auto-refresh when visible)
        let _poolPollTimer = null;
        function startPoolPolling() {
            if (_poolPollTimer) return;
            _poolPollTimer = setInterval(async () => {
                const section = document.getElementById('modelPoolsSection');
                if (!section || section.style.display === 'none') return;
                try {
                    const res = await fetch('/model-routing/pools');
                    if (res.ok) {
                        const pools = await res.json();
                        if (modelRoutingData) {
                            modelRoutingData.pools = pools;
                            renderPoolStatus(modelRoutingData);
                        }
                        // Update TierBuilder from polling
                        if (window._tierBuilder && modelRoutingData.pools) {
                            window._tierBuilder.updatePoolStatus(modelRoutingData.pools);
                        }
                    }
                } catch (_e) { /* ignore poll errors */ }
            }, 3000);
        }
        function stopPoolPolling() {
            if (_poolPollTimer) {
                clearInterval(_poolPollTimer);
                _poolPollTimer = null;
            }
        }

        // ========== TIER BUILDER (Drag-and-Drop) ==========
        class TierBuilder {
            constructor() {
                // DOM references
                this.container = document.getElementById('tierBuilderContainer');
                this.bankList = document.getElementById('modelsBankList');
                this.lanes = {
                    heavy: document.getElementById('tierLaneHeavy'),
                    medium: document.getElementById('tierLaneMedium'),
                    light: document.getElementById('tierLaneLight')
                };
                this.strategySelects = {
                    heavy: document.getElementById('tierStrategyHeavy'),
                    medium: document.getElementById('tierStrategyMedium'),
                    light: document.getElementById('tierStrategyLight')
                };
                this.pendingBadge = document.getElementById('tierBuilderPending');
                this.pendingCount = document.getElementById('tierBuilderPendingCount');
                this.saveBtn = document.getElementById('tierBuilderSave');
                this.resetBtn = document.getElementById('tierBuilderReset');
                this.bankCountEl = document.getElementById('modelsBankCount');

                // State
                this.serverState = null;   // Last known server config (from GET /model-routing)
                this.sortables = {};       // SortableJS instances by key (bank, heavy, medium, light)
                this._saveDebounceTimer = null;
                this._destroyed = false;

                // Bind event handlers
                this._onSave = () => this.save();
                this._onReset = () => this.reset();
                this._onStrategyChange = () => this._computePendingChanges();

                // Attach button listeners
                if (this.saveBtn) this.saveBtn.addEventListener('click', this._onSave);
                if (this.resetBtn) this.resetBtn.addEventListener('click', this._onReset);

                // Attach strategy dropdown listeners
                Object.values(this.strategySelects).forEach(sel => {
                    if (sel) sel.addEventListener('change', this._onStrategyChange);
                });
            }

            /**
             * Render the tier builder from routing data and available models.
             * Called by renderModelRouting() when data is available.
             * @param {Object} routingData - GET /model-routing response
             * @param {Object} modelsData - STATE.modelsData (keyed by model ID)
             * @param {string[]} availableModels - getAvailableModels() result
             */
            render(routingData, modelsData, availableModels) {
                if (!this.container) return;

                // Store server state baseline for reset/diff
                this.serverState = this._extractTierState(routingData);

                // Destroy existing SortableJS instances
                this._destroySortables();

                // Render upgrade info panel (UIUX-02)
                this._renderUpgradeInfo(routingData);

                // Populate bank with all available models
                this._renderBank(availableModels, modelsData);

                // Populate tier lanes from config
                const tiers = routingData?.config?.tiers || {};
                for (const [tierName, lane] of Object.entries(this.lanes)) {
                    if (!lane) continue;
                    const tierConfig = tiers[tierName];
                    const models = this._getTierModels(tierConfig);
                    this._renderLane(lane, tierName, models, modelsData);

                    // Set strategy dropdown
                    const stratSel = this.strategySelects[tierName];
                    if (stratSel && tierConfig) {
                        const strategy = tierConfig.strategy || 'balanced';
                        stratSel.value = strategy;
                    }
                }

                // Initialize SortableJS instances
                this._initSortable();

                // Clear pending state
                this._updatePending(0);

                // Update shadow badges for GLM-5 models
                this.updateShadowBadges(routingData?.config);
            }

            /**
             * Render upgrade explanation panel (UIUX-02).
             * Shows complexity upgrade thresholds above tier lanes.
             */
            _renderUpgradeInfo(routingData) {
                // Check if panel already exists
                let panel = document.getElementById('upgradeInfoPanel');
                if (panel) {
                    panel.remove();
                }

                const thresholds = routingData?.config?.classifier?.complexityUpgrade?.thresholds;
                if (!thresholds) {
                    // No upgrade config, don't show panel
                    return;
                }

                // Create upgrade info panel
                panel = document.createElement('div');
                panel.id = 'upgradeInfoPanel';
                panel.className = 'upgrade-info-panel';

                const toggle = document.createElement('button');
                toggle.className = 'upgrade-info-toggle';
                toggle.setAttribute('data-action', 'toggle-upgrade-info');
                toggle.innerHTML = `
                    <span>Why upgrade to Heavy tier?</span>
                    <span class="chevron">▼</span>
                `;

                const content = document.createElement('div');
                content.className = 'upgrade-info-content';
                content.id = 'upgradeInfoContent';
                content.innerHTML = `
                    <p>Sonnet and Opus requests upgrade to Heavy tier via scoped rules when:</p>
                    <ul class="upgrade-triggers-list">
                        <li>${escapeHtml('Has tools')} - Request includes function calling</li>
                        <li>${escapeHtml('Has vision')} - Request includes images</li>
                        <li>${escapeHtml(`Max tokens > ${thresholds.maxTokens || '8192'}`)} - Large token requests</li>
                        <li>${escapeHtml(`Messages > ${thresholds.messageCount || '10'}`)} - Long conversations</li>
                        <li>${escapeHtml(`System > ${thresholds.systemLength || '1000'} chars`)} - Long system prompts</li>
                    </ul>
                    <p class="upgrade-info-note">
                        Upgrades are driven by scoped rules (Sonnet/Opus only). Haiku requests stay in their assigned tier. Env var thresholds (<code>GLM_COMPLEXITY_UPGRADE_*</code>) provide telemetry classification.
                    </p>
                `;

                panel.appendChild(toggle);
                panel.appendChild(content);

                // Insert panel at the beginning of tier builder container (before models bank)
                if (this.container) {
                    this.container.insertBefore(panel, this.container.firstChild);
                }

                // Toggle functionality
                toggle.addEventListener('click', () => {
                    const isExpanded = content.classList.contains('expanded');
                    if (isExpanded) {
                        content.classList.remove('expanded');
                        toggle.classList.remove('expanded');
                    } else {
                        content.classList.add('expanded');
                        toggle.classList.add('expanded');
                    }
                });
            }

            /**
             * Extract tier state from routing data for diff comparison.
             * Normalizes v1 and v2 formats into a canonical shape.
             */
            _extractTierState(routingData) {
                const tiers = routingData?.config?.tiers || {};
                const state = {};
                for (const [name, cfg] of Object.entries(tiers)) {
                    state[name] = {
                        models: this._getTierModels(cfg),
                        strategy: cfg.strategy || 'balanced'
                    };
                }
                return state;
            }

            /**
             * Get ordered model list from tier config (handles v1 and v2 formats).
             */
            _getTierModels(tierConfig) {
                if (!tierConfig) return [];
                // V2 format: models[] array
                if (Array.isArray(tierConfig.models) && tierConfig.models.length > 0) {
                    return [...tierConfig.models];
                }
                // V1 format: targetModel + fallbackModels
                const models = [];
                if (tierConfig.targetModel) models.push(tierConfig.targetModel);
                if (Array.isArray(tierConfig.fallbackModels)) {
                    models.push(...tierConfig.fallbackModels);
                } else if (tierConfig.failoverModel) {
                    models.push(tierConfig.failoverModel);
                }
                return models.filter(Boolean);
            }

            /**
             * Build a model card DOM element.
             * @param {string} modelId - Model ID
             * @param {Object} modelsData - STATE.modelsData
             * @param {Object} [options] - { position, inTier, showRemove }
             * @returns {HTMLElement}
             */
            _buildModelCard(modelId, modelsData, options = {}) {
                const { position = null, inTier = false, showRemove = false } = options;
                const modelData = modelsData && modelsData[modelId];
                const displayName = modelData?.displayName || modelId;

                const card = document.createElement('div');
                card.className = 'model-card';
                card.setAttribute('data-model-id', modelId);

                // Top row: name + position
                const top = document.createElement('div');
                top.className = 'model-card-top';

                const nameEl = document.createElement('span');
                nameEl.className = 'model-card-name';
                nameEl.textContent = displayName;
                nameEl.title = modelId;
                top.appendChild(nameEl);

                if (position !== null) {
                    const posEl = document.createElement('span');
                    posEl.className = 'model-card-position';
                    posEl.textContent = '#' + (position + 1);
                    top.appendChild(posEl);
                }

                card.appendChild(top);

                // Badges row (shared, cooldown - added dynamically)
                const badges = document.createElement('div');
                badges.className = 'model-card-badges';
                card.appendChild(badges);

                // Concurrency bar (placeholder - updated by pool status)
                const bar = document.createElement('div');
                bar.className = 'model-card-bar';
                const barFill = document.createElement('div');
                barFill.className = 'model-card-bar-fill bar-low';
                barFill.style.width = '0%';
                bar.appendChild(barFill);
                // Add placeholder for outer text (when bar is too small for inline text)
                const barOuter = document.createElement('span');
                barOuter.className = 'model-card-bar-outer';
                barOuter.style.display = 'none';
                bar.appendChild(barOuter);
                card.appendChild(bar);

                // Remove button (only in tier lanes, not bank)
                if (showRemove) {
                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'model-card-remove';
                    removeBtn.textContent = '\u00d7'; // multiplication sign
                    removeBtn.title = 'Remove from tier';
                    removeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        card.remove();
                        this._onDragEnd();
                    });
                    card.appendChild(removeBtn);
                }

                return card;
            }

            /**
             * Render the available models bank.
             */
            _renderBank(availableModels, modelsData) {
                if (!this.bankList) return;
                this.bankList.innerHTML = '';

                if (!availableModels || availableModels.length === 0) {
                    this.bankList.innerHTML = '<div class="tier-builder-empty">No models available</div>';
                    if (this.bankCountEl) this.bankCountEl.textContent = '0';
                    return;
                }

                availableModels.forEach(modelId => {
                    const card = this._buildModelCard(modelId, modelsData, { showRemove: false });
                    this.bankList.appendChild(card);
                });

                if (this.bankCountEl) this.bankCountEl.textContent = String(availableModels.length);
            }

            /**
             * Render a single tier lane with its models.
             */
            _renderLane(laneEl, tierName, models, modelsData) {
                if (!laneEl) return;
                laneEl.innerHTML = '';

                if (models.length === 0) {
                    laneEl.innerHTML = renderEmptyState('Drop models here', { icon: '↓' });
                    return;
                }

                models.forEach((modelId, i) => {
                    const card = this._buildModelCard(modelId, modelsData, {
                        position: i,
                        inTier: true,
                        showRemove: true
                    });
                    laneEl.appendChild(card);
                });
            }

            /**
             * Initialize SortableJS instances for bank and all tier lanes.
             */
            _initSortable() {
                if (!FEATURES.sortable) {
                    console.warn('SortableJS not available - drag-and-drop disabled');
                    // Show message in tier builder
                    const builder = document.querySelector('.tier-builder-content');
                    if (builder) {
                        const msg = document.createElement('div');
                        msg.className = 'sortable-unavailable';
                        msg.textContent = 'Drag-and-drop unavailable - SortableJS not loaded';
                        msg.style.cssText = 'padding: 12px; background: #fff3cd; color: #856404; border-radius: 4px; margin: 8px 0; text-align: center;';
                        builder.insertBefore(msg, builder.firstChild);
                    }
                    return;
                }

                // Bank: clone on drag out, don't allow drops back in
                if (this.bankList) {
                    this.sortables.bank = Sortable.create(this.bankList, {
                        group: { name: 'models', pull: 'clone', put: false },
                        sort: false,
                        animation: 150,
                        swapThreshold: 0.65,
                        invertSwap: true,
                        fallbackOnBody: true,
                        forceFallback: true,
                        scrollSensitivity: 60,
                        ghostClass: 'sortable-ghost',
                        chosenClass: 'sortable-chosen',
                        dragClass: 'sortable-drag',
                        filter: '.tier-builder-empty',
                        onClone: (evt) => {
                            // Add remove button to the cloned card entering a tier
                            const clone = evt.clone;
                            if (!clone.querySelector('.model-card-remove')) {
                                const removeBtn = document.createElement('button');
                                removeBtn.className = 'model-card-remove';
                                removeBtn.textContent = '\u00d7';
                                removeBtn.title = 'Remove from tier';
                                removeBtn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    clone.remove();
                                    this._onDragEnd();
                                });
                                clone.appendChild(removeBtn);
                            }
                        }
                    });
                }

                // Tier lanes: full move between lanes, accept from bank
                for (const [tierName, laneEl] of Object.entries(this.lanes)) {
                    if (!laneEl) continue;
                    this.sortables[tierName] = Sortable.create(laneEl, {
                        group: { name: 'models', pull: true, put: true },
                        sort: true,
                        animation: 150,
                        swapThreshold: 0.65,
                        invertSwap: true,
                        fallbackOnBody: true,
                        forceFallback: true,
                        scrollSensitivity: 60,
                        ghostClass: 'sortable-ghost',
                        chosenClass: 'sortable-chosen',
                        dragClass: 'sortable-drag',
                        filter: '.tier-lane-empty',
                        onAdd: (evt) => {
                            // Remove empty state when a card is added
                            const empty = laneEl.querySelector('.tier-lane-empty');
                            if (empty) empty.remove();
                            // Ensure remove button exists on added card
                            const card = evt.item;
                            if (!card.querySelector('.model-card-remove')) {
                                const removeBtn = document.createElement('button');
                                removeBtn.className = 'model-card-remove';
                                removeBtn.textContent = '\u00d7';
                                removeBtn.title = 'Remove from tier';
                                removeBtn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    card.remove();
                                    this._onDragEnd();
                                });
                                card.appendChild(removeBtn);
                            }
                            this._onDragEnd();
                        },
                        onRemove: (evt) => {
                            // Show empty state if lane is now empty
                            const modelCards = laneEl.querySelectorAll('.model-card');
                            if (modelCards.length === 0) {
                                laneEl.innerHTML = renderEmptyState('Drop models here', { icon: '↓' });
                            }
                            this._onDragEnd();
                        },
                        onUpdate: () => {
                            // Reorder within same lane
                            this._onDragEnd();
                        }
                    });
                }
            }

            /**
             * Called after any drag/drop event (add, remove, update, card removal).
             * Updates position numbers, detects shared models, computes pending changes.
             */
            _onDragEnd() {
                this._updatePositions();
                this._detectSharedModels();
                this._computePendingChanges();
            }

            /**
             * Update position numbers (#1, #2, ...) on all cards in tier lanes.
             */
            _updatePositions() {
                for (const laneEl of Object.values(this.lanes)) {
                    if (!laneEl) continue;
                    const cards = laneEl.querySelectorAll('.model-card');
                    cards.forEach((card, i) => {
                        let posEl = card.querySelector('.model-card-position');
                        if (!posEl) {
                            posEl = document.createElement('span');
                            posEl.className = 'model-card-position';
                            const top = card.querySelector('.model-card-top');
                            if (top) top.appendChild(posEl);
                        }
                        posEl.textContent = '#' + (i + 1);
                    });
                }
            }

            /**
             * Detect models appearing in multiple tiers and toggle "Shared" badge (UI-04).
             */
            _detectSharedModels() {
                // Count occurrences of each model across all tier lanes
                const modelCounts = {};
                for (const laneEl of Object.values(this.lanes)) {
                    if (!laneEl) continue;
                    const cards = laneEl.querySelectorAll('.model-card');
                    cards.forEach(card => {
                        const modelId = card.getAttribute('data-model-id');
                        if (modelId) {
                            modelCounts[modelId] = (modelCounts[modelId] || 0) + 1;
                        }
                    });
                }

                // Update shared badges on all cards in all lanes
                for (const laneEl of Object.values(this.lanes)) {
                    if (!laneEl) continue;
                    const cards = laneEl.querySelectorAll('.model-card');
                    cards.forEach(card => {
                        const modelId = card.getAttribute('data-model-id');
                        const isShared = modelId && modelCounts[modelId] > 1;
                        const badges = card.querySelector('.model-card-badges');
                        if (!badges) return;

                        let sharedBadge = badges.querySelector('.model-card-shared');
                        if (isShared && !sharedBadge) {
                            sharedBadge = document.createElement('span');
                            sharedBadge.className = 'model-card-shared';
                            sharedBadge.textContent = 'Shared';
                            badges.appendChild(sharedBadge);
                        } else if (!isShared && sharedBadge) {
                            sharedBadge.remove();
                        }
                    });
                }
            }

            /**
             * Compute the number of pending changes by diffing local vs server state.
             */
            _computePendingChanges() {
                if (!this.serverState) {
                    this._updatePending(0);
                    return;
                }

                let count = 0;
                const currentState = this._getCurrentState();

                for (const tierName of ['heavy', 'medium', 'light']) {
                    const server = this.serverState[tierName] || { models: [], strategy: 'balanced' };
                    const current = currentState[tierName] || { models: [], strategy: 'balanced' };

                    // Check strategy change
                    if (server.strategy !== current.strategy) count++;

                    // Check model list change (order matters)
                    if (server.models.length !== current.models.length) {
                        count++;
                    } else {
                        for (let i = 0; i < server.models.length; i++) {
                            if (server.models[i] !== current.models[i]) {
                                count++;
                                break;
                            }
                        }
                    }
                }

                this._updatePending(count);
            }

            /**
             * Get current tier state from the DOM (model order from SortableJS).
             */
            _getCurrentState() {
                const state = {};
                for (const [tierName, laneEl] of Object.entries(this.lanes)) {
                    const models = [];
                    if (laneEl) {
                        const cards = laneEl.querySelectorAll('.model-card');
                        cards.forEach(card => {
                            const modelId = card.getAttribute('data-model-id');
                            if (modelId) models.push(modelId);
                        });
                    }
                    const stratSel = this.strategySelects[tierName];
                    const strategy = stratSel ? stratSel.value : 'balanced';
                    state[tierName] = { models, strategy };
                }
                return state;
            }

            /**
             * Update the pending badge and enable/disable Save/Reset buttons.
             * @param {number} count - Number of pending changes
             */
            _updatePending(count) {
                if (this.pendingBadge) {
                    this.pendingBadge.style.display = count > 0 ? 'inline-block' : 'none';
                }
                if (this.pendingCount) {
                    this.pendingCount.textContent = String(count);
                }
                if (this.saveBtn) {
                    this.saveBtn.disabled = count === 0;
                }
                if (this.resetBtn) {
                    this.resetBtn.disabled = count === 0;
                }
            }

            /**
             * Save current tier configuration to server (UI-06).
             * Debounced PUT /model-routing with 500ms delay.
             */
            save() {
                if (this._saveDebounceTimer) {
                    clearTimeout(this._saveDebounceTimer);
                }
                this._saveDebounceTimer = setTimeout(() => {
                    this._doSave();
                }, 500);
            }

            /**
             * Execute the actual PUT request.
             */
            async _doSave() {
                const currentState = this._getCurrentState();
                const payload = { tiers: {} };

                for (const [tierName, state] of Object.entries(currentState)) {
                    payload.tiers[tierName] = {
                        models: state.models,
                        strategy: state.strategy
                    };
                }

                const saveAction = async () => {
                    const res = await fetch('/model-routing', {
                        method: 'PUT',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(payload)
                    });

                    if (res.ok) {
                        const result = await res.json().catch(() => ({}));
                        if (result.persisted) {
                            showToast('Tier configuration saved and persisted', 'success');
                        } else {
                            showToast('Tier configuration updated (runtime only)', 'warning');
                        }
                        // Re-fetch to sync server state
                        await fetchModelRouting();
                    } else {
                        // UI-08: Error recovery
                        const err = await res.json().catch(() => ({}));
                        showToast('Save failed: ' + (err.error || res.statusText), 'error');
                        // Re-fetch server state and revert
                        await fetchModelRouting();
                    }
                };

                if (this.saveBtn) {
                    await withLoading(this.saveBtn, saveAction, { busyText: 'Saving...' });
                } else {
                    await saveAction();
                }
            }

            /**
             * Reset tier builder to server state (UI-07).
             */
            reset() {
                if (modelRoutingData) {
                    this.render(modelRoutingData, STATE.modelsData, getAvailableModels());
                    showToast('Tier configuration reset to server state', 'info');
                }
            }

            /**
             * Update concurrency bars on model cards from pool status data (POOL-01).
             * Called when pool-status SSE events arrive or from polling.
             * @param {Object} pools - Pool data: { tier: [{ model, inFlight, maxConcurrency, ... }] }
             */
            updatePoolStatus(pools) {
                if (!pools) return;

                for (const [tierName, models] of Object.entries(pools)) {
                    if (!Array.isArray(models)) continue;
                    const laneEl = this.lanes[tierName];
                    if (!laneEl) continue;

                    models.forEach(m => {
                        // Find all cards for this model (may be in multiple tiers - POOL-02)
                        this._updateModelCards(m.model, m.inFlight, m.maxConcurrency, m.cooldownMs);
                    });
                }
            }

            /**
             * Update all model cards matching a model ID across all lanes (POOL-02).
             */
            _updateModelCards(modelId, inFlight, maxConcurrency, cooldownMs) {
                const allCards = this.container
                    ? this.container.querySelectorAll(`.model-card[data-model-id="${CSS.escape(modelId)}"]`)
                    : [];

                const isAtCapacity = maxConcurrency > 0 && inFlight >= maxConcurrency;
                const isGLM5 = modelId.includes('glm-5');

                allCards.forEach(card => {
                    // Update concurrency bar
                    const barFill = card.querySelector('.model-card-bar-fill');
                    const bar = card.querySelector('.model-card-bar');
                    let barOuter = card.querySelector('.model-card-bar-outer');

                    if (barFill && maxConcurrency > 0) {
                        const pct = Math.round((inFlight / maxConcurrency) * 100);
                        barFill.style.width = pct + '%';
                        barFill.className = 'model-card-bar-fill ' + (
                            cooldownMs > 0 ? 'bar-cooled' :
                            pct >= 80 ? 'bar-high' :
                            pct >= 50 ? 'bar-medium' : 'bar-low'
                        );

                        // Show value inside bar if wide enough, otherwise outside
                        const showInline = pct >= 25;
                        const valueText = `${inFlight}/${maxConcurrency}`;

                        if (showInline) {
                            barFill.innerHTML = `<span class="model-card-bar-text">${valueText}</span>`;
                            if (barOuter) {
                                barOuter.textContent = '';
                                barOuter.style.display = 'none';
                            }
                        } else {
                            barFill.innerHTML = '';
                            if (!barOuter && bar) {
                                barOuter = document.createElement('span');
                                barOuter.className = 'model-card-bar-outer';
                                bar.appendChild(barOuter);
                            }
                            if (barOuter) {
                                barOuter.textContent = valueText;
                                barOuter.style.display = '';
                            }
                        }
                    }

                    // Update busy state indicator (UIUX-03)
                    let busyBadge = card.querySelector('.model-busy-indicator');
                    if (isAtCapacity && isGLM5) {
                        if (!busyBadge) {
                            busyBadge = document.createElement('div');
                            busyBadge.className = 'model-busy-indicator';
                            busyBadge.title = 'Model at capacity - requests will fall back to other Heavy tier models';
                            busyBadge.innerHTML = `
                                <span class="busy-icon">⚠</span>
                                <span class="busy-text">Busy (${inFlight}/${maxConcurrency})</span>
                            `;
                            // Insert busy badge at the top of the card (before top element)
                            card.insertBefore(busyBadge, card.firstChild);
                        } else {
                            // Update existing badge with current counts
                            const busyText = busyBadge.querySelector('.busy-text');
                            if (busyText) {
                                busyText.textContent = `Busy (${inFlight}/${maxConcurrency})`;
                            }
                        }
                    } else if (busyBadge) {
                        // Remove busy badge if no longer at capacity or not GLM-5
                        busyBadge.remove();
                    }

                    // Update cooldown badge (POOL-03)
                    const badges = card.querySelector('.model-card-badges');
                    if (badges) {
                        let cooldownBadge = badges.querySelector('.model-card-cooldown');
                        if (cooldownMs > 0) {
                            const secs = Math.ceil(cooldownMs / 1000);
                            if (!cooldownBadge) {
                                cooldownBadge = document.createElement('span');
                                cooldownBadge.className = 'model-card-cooldown';
                                badges.appendChild(cooldownBadge);
                            }
                            cooldownBadge.textContent = secs + 's';
                        } else if (cooldownBadge) {
                            cooldownBadge.remove();
                        }
                    }
                });
            }

            /**
             * Update shadow badges for GLM-5 models when in shadow mode.
             * Shadow mode = glm5.enabled !== false AND glm5.preferencePercent === 0
             * @param {Object} routingConfig - config object from GET /model-routing response
             */
            updateShadowBadges(routingConfig) {
                if (!this.container) return;

                // Determine if shadow mode is active
                // Note: glm5.enabled defaults to true when not explicitly set (model-router.js line 1663)
                const glm5Config = routingConfig?.glm5 || {};
                const isShadowMode = glm5Config.enabled !== false && (glm5Config.preferencePercent ?? 0) === 0;

                // Find all model cards in the tier builder
                const allCards = this.container.querySelectorAll('.model-card');

                allCards.forEach(card => {
                    const modelId = card.getAttribute('data-model-id');
                    const isGLM5 = modelId && modelId.includes('glm-5');
                    const badges = card.querySelector('.model-card-badges');
                    if (!badges) return;

                    let shadowBadge = badges.querySelector('.model-card-shadow');

                    if (isShadowMode && isGLM5) {
                        // Add shadow badge if not present
                        if (!shadowBadge) {
                            shadowBadge = document.createElement('span');
                            shadowBadge.className = 'model-card-shadow';
                            shadowBadge.textContent = 'Shadow';
                            shadowBadge.title = 'Shadow mode: GLM-5 preference is 0% (tracking eligible requests only)';
                            badges.appendChild(shadowBadge);
                        }
                    } else if (shadowBadge) {
                        // Remove shadow badge if no longer in shadow mode or not GLM-5
                        shadowBadge.remove();
                    }
                });
            }

            /**
             * Destroy all SortableJS instances and clean up event listeners.
             */
            _destroySortables() {
                for (const [key, sortable] of Object.entries(this.sortables)) {
                    if (sortable && typeof sortable.destroy === 'function') {
                        sortable.destroy();
                    }
                }
                this.sortables = {};
            }

            /**
             * Full cleanup (call when navigating away or rebuilding).
             */
            destroy() {
                this._destroyed = true;
                this._destroySortables();

                if (this._saveDebounceTimer) {
                    clearTimeout(this._saveDebounceTimer);
                    this._saveDebounceTimer = null;
                }

                if (this.saveBtn) this.saveBtn.removeEventListener('click', this._onSave);
                if (this.resetBtn) this.resetBtn.removeEventListener('click', this._onReset);
                Object.values(this.strategySelects).forEach(sel => {
                    if (sel) sel.removeEventListener('change', this._onStrategyChange);
                });

                window._tierBuilder = null;
            }
        }

        // ========== EDITABLE TIER SAVE ==========
        // Helper: withLoading wrapper (reusable component)
        async function withLoading(btn, fn, { busyText = 'Saving...' } = {}) {
            const originalText = btn.textContent;
            const originalDisabled = btn.disabled;

            try {
                btn.disabled = true;
                btn.setAttribute('aria-busy', 'true');
                btn.textContent = busyText;

                if (window.__DASHBOARD_DEBUG__) {
                    window.__DASHBOARD_DEBUG__.loading.inFlight++;
                }

                const result = await fn();

                return result;
            } catch (error) {
                btn.textContent = 'Failed';
                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.disabled = originalDisabled;
                    btn.removeAttribute('aria-busy');
                }, 1000);
                throw error;
            } finally {
                if (btn.textContent === busyText) {
                    btn.textContent = originalText;
                    btn.disabled = originalDisabled;
                    btn.removeAttribute('aria-busy');
                }
                if (window.__DASHBOARD_DEBUG__) {
                    window.__DASHBOARD_DEBUG__.loading.inFlight--;
                }
            }
        }

        async function saveTierConfig(tierName) {
            // Legacy: replaced by TierBuilder unified save. Keep for backward compat.
            if (window._tierBuilder) return;
            const btn = document.querySelector('[data-action="save-tier"][data-tier="' + tierName + '"]');
            const row = document.querySelector('[data-tier="' + tierName + '"][data-field="targetModel"]')?.closest('tr');
            if (!row) return;

            const targetModel = row.querySelector('[data-field="targetModel"]').value.trim();
            const fallbackStr = row.querySelector('[data-field="fallbackModels"]').value.trim();
            const strategy = row.querySelector('[data-field="strategy"]').value;
            const policy = row.querySelector('[data-field="clientModelPolicy"]').value;

            const fallbackModels = fallbackStr ? fallbackStr.split(',').map(s => s.trim()).filter(Boolean) : [];

            const saveAction = async () => {
                const res = await fetch('/model-routing', {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        tiers: {
                            [tierName]: { targetModel, fallbackModels, strategy, clientModelPolicy: policy }
                        }
                    })
                });
                if (res.ok) {
                    const result = await res.json().catch(() => ({}));
                    if (result.persisted) {
                        showToast('Tier "' + tierName + '" updated and persisted', 'success');
                    } else {
                        showToast('Tier "' + tierName + '" updated (runtime only)', 'warning');
                    }
                    fetchModelRouting();
                } else {
                    const err = await res.json().catch(() => ({}));
                    showToast('Failed: ' + (err.error || res.statusText), 'error');
                }
            };

            // Wrap with loading state if button exists
            if (btn) {
                await withLoading(btn, saveAction, { busyText: 'Saving...' });
            } else {
                await saveAction();
            }
        }

        // ========== ROUTING RULES ==========
        function renderRoutingRules(data) {
            const body = document.getElementById('routingRulesBody');
            if (!body) return;
            const rules = data?.config?.rules || [];
            if (rules.length === 0) {
                body.innerHTML = '<tr><td colspan="4" style="color: var(--text-secondary);">No rules configured</td></tr>';
                return;
            }
            body.innerHTML = rules.map((rule, i) => {
                const match = rule.match || {};
                const conditions = [];
                if (match.model) conditions.push('model: ' + match.model);
                if (match.maxTokensGte) conditions.push('tokens ≥ ' + match.maxTokensGte);
                if (match.messageCountGte) conditions.push('msgs ≥ ' + match.messageCountGte);
                if (match.hasTools) conditions.push('tools');
                if (match.hasVision) conditions.push('vision');
                return '<tr>' +
                    '<td>' + escapeHtml(match.model || '*') + '</td>' +
                    '<td>' + (conditions.length ? escapeHtml(conditions.join(', ')) : '<span style="color:var(--text-secondary)">any</span>') + '</td>' +
                    '<td style="font-weight:600;">' + escapeHtml(rule.tier || '-') + '</td>' +
                    '<td><button class="btn btn-danger btn-small" data-action="remove-routing-rule" data-rule-index="' + i + '">×</button></td>' +
                    '</tr>';
            }).join('');
        }

        async function addRoutingRule() {
            const model = document.getElementById('ruleModelGlob')?.value?.trim() || null;
            const maxTokensGte = parseInt(document.getElementById('ruleMaxTokens')?.value) || undefined;
            const messageCountGte = parseInt(document.getElementById('ruleMessages')?.value) || undefined;
            const hasTools = document.getElementById('ruleHasTools')?.checked || undefined;
            const hasVision = document.getElementById('ruleHasVision')?.checked || undefined;
            const tier = document.getElementById('ruleTier')?.value || 'light';

            const match = {};
            if (model) match.model = model;
            if (maxTokensGte) match.maxTokensGte = maxTokensGte;
            if (messageCountGte) match.messageCountGte = messageCountGte;
            if (hasTools) match.hasTools = true;
            if (hasVision) match.hasVision = true;

            const currentRules = modelRoutingData?.config?.rules || [];
            const newRules = [...currentRules, { match, tier }];

            try {
                const res = await fetch('/model-routing', {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ rules: newRules })
                });
                if (res.ok) {
                    showToast('Rule added', 'success');
                    // Clear form
                    if (document.getElementById('ruleModelGlob')) document.getElementById('ruleModelGlob').value = '';
                    if (document.getElementById('ruleMaxTokens')) document.getElementById('ruleMaxTokens').value = '';
                    if (document.getElementById('ruleMessages')) document.getElementById('ruleMessages').value = '';
                    if (document.getElementById('ruleHasTools')) document.getElementById('ruleHasTools').checked = false;
                    if (document.getElementById('ruleHasVision')) document.getElementById('ruleHasVision').checked = false;
                    fetchModelRouting();
                } else {
                    showToast('Failed to add rule', 'error');
                }
            } catch (err) {
                showToast('Failed to add rule', 'error');
            }
        }

        async function removeRoutingRule(index) {
            const currentRules = modelRoutingData?.config?.rules || [];
            const newRules = currentRules.filter((_, i) => i !== index);
            try {
                const res = await fetch('/model-routing', {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ rules: newRules })
                });
                if (res.ok) {
                    showToast('Rule removed', 'success');
                    fetchModelRouting();
                } else {
                    showToast('Failed to remove rule', 'error');
                }
            } catch (err) {
                showToast('Failed to remove rule', 'error');
            }
        }

        // ========== PER-MODEL USAGE ==========
        function renderModelUsage() {
            const body = document.getElementById('modelUsageBody');
            if (!body) return;

            // Get model stats from the latest stats data
            const stats = STATE.statsData?.modelStats || {};

            // Filter to show only GLM (upstream) models, not Claude (original) models
            // Claude models are shown in the Model Mappings section with their GLM targets
            const entries = Object.entries(stats).filter(([model]) => {
                // GLM models start with 'glm-', 'cogview-', or are known z.ai models
                // Claude models start with 'claude-' and should be filtered out
                return model.startsWith('glm-') ||
                       model.startsWith('cogview-') ||
                       model === 'glm-ocr' ||
                       model === 'glm-flash';
            });

            if (entries.length === 0) {
                body.innerHTML = renderTableEmptyState(6, 'No data yet');
                return;
            }

            body.innerHTML = entries
                .sort((a, b) => b[1].requests - a[1].requests)
                .map(([model, s]) => {
                    const successRate = s.successRate != null ? s.successRate.toFixed(1) + '%' : '-';
                    const avgLatency = s.avgLatencyMs != null ? Math.round(s.avgLatencyMs) + 'ms' : '-';
                    const tokens = (s.inputTokens || 0).toLocaleString() + ' / ' + (s.outputTokens || 0).toLocaleString();
                    return '<tr>' +
                        '<td style="font-family: JetBrains Mono, monospace; font-size: 0.75rem;">' + escapeHtml(model) + '</td>' +
                        '<td>' + s.requests + '</td>' +
                        '<td>' + successRate + '</td>' +
                        '<td>' + (s.rate429 || 0) + '</td>' +
                        '<td>' + avgLatency + '</td>' +
                        '<td style="font-size: 0.7rem;">' + tokens + '</td>' +
                        '</tr>';
                }).join('');
        }

        async function runRoutingTest() {
            const availableModels = getAvailableModels();
            const defaultModel = availableModels.length > 0 ? availableModels[0] : '';
            const model = document.getElementById('routingTestModel')?.value || defaultModel;
            const maxTokens = document.getElementById('routingTestMaxTokens')?.value;
            const messages = document.getElementById('routingTestMessages')?.value || '1';
            const systemLength = document.getElementById('routingTestSystemLength')?.value || '0';
            const tools = document.getElementById('routingTestTools')?.checked || false;
            const vision = document.getElementById('routingTestVision')?.checked || false;

            let url = '/model-routing/test?model=' + encodeURIComponent(model) +
                '&messages=' + encodeURIComponent(messages) +
                '&system_length=' + encodeURIComponent(systemLength);
            if (maxTokens) url += '&max_tokens=' + encodeURIComponent(maxTokens);
            if (tools) url += '&tools=true';
            if (vision) url += '&vision=true';

            try {
                const res = await fetch(url);
                const data = await res.json();
                const resultEl = document.getElementById('routingTestResult');
                if (resultEl) {
                    resultEl.classList.add('visible');
                    const tier = data.classification?.tier || 'none';
                    const reason = data.classification?.reason || 'no match';
                    const target = data.selectedModel || data.targetModel || 'passthrough';
                    resultEl.innerHTML =
                        '<strong>Tier:</strong> ' + escapeHtml(tier) +
                        ' | <strong>Target:</strong> ' + escapeHtml(target) +
                        '<br><strong>Reason:</strong> ' + escapeHtml(reason);
                }
            } catch (err) {
                showToast('Test failed: ' + err.message, 'error');
            }
        }

        // ========== EXPLAIN ROUTING DECISION ==========
        async function runExplain() {
            const model = document.getElementById('routingTestModel')?.value || 'claude-sonnet-4-5-20250929';
            const maxTokensStr = document.getElementById('routingTestMaxTokens')?.value;
            const messageCount = parseInt(document.getElementById('routingTestMessages')?.value) || 1;
            const systemLength = parseInt(document.getElementById('routingTestSystemLength')?.value) || 0;
            const hasTools = document.getElementById('routingTestTools') ? document.getElementById('routingTestTools').checked : false;
            const hasVision = document.getElementById('routingTestVision') ? document.getElementById('routingTestVision').checked : false;

            const body = { model: model, messageCount: messageCount, systemLength: systemLength, hasTools: hasTools, hasVision: hasVision };
            if (maxTokensStr) body.maxTokens = parseInt(maxTokensStr);

            const btn = document.getElementById('explainBtn');
            if (btn) btn.disabled = true;

            try {
                const res = await fetch('/model-routing/explain', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json();
                renderExplainResult(data);
            } catch (err) {
                const container = document.getElementById('explainResult');
                if (container) {
                    container.style.display = 'block';
                    container.innerHTML = '<div class="explain-result"><div class="explain-reason">Error: ' + escapeHtml(err.message) + '</div></div>';
                }
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        function renderExplainResult(data) {
            const container = document.getElementById('explainResult');
            if (!container) return;

            container.style.display = 'block';

            let html = '<div class="explain-result">';

            // Decision summary
            html += '<div class="explain-summary">';
            html += '<strong>Selected:</strong> ' + escapeHtml(data.selectedModel);
            if (data.tier) {
                html += ' <span class="tier-badge tier-badge-' + escapeHtml(data.tier) + '">' + escapeHtml(data.tier) + '</span>';
            }
            if (data.strategy) {
                html += ' <span class="strategy-label">' + escapeHtml(data.strategy) + '</span>';
            }
            html += '</div>';

            // Reason
            if (data.reason) {
                html += '<div class="explain-reason">' + escapeHtml(data.reason) + '</div>';
            }

            // Scoring table
            if (data.scoringTable && data.scoringTable.length > 0) {
                html += '<table class="explain-scoring-table">';
                html += '<thead><tr><th>Model</th><th>Pos</th><th>Score</th><th>Avail</th><th>Max</th><th>Cost</th><th>Hits</th><th></th></tr></thead>';
                html += '<tbody>';
                for (let i = 0; i < data.scoringTable.length; i++) {
                    const row = data.scoringTable[i];
                    html += '<tr' + (row.selected ? ' class="selected"' : '') + '>';
                    html += '<td>' + escapeHtml(row.model) + '</td>';
                    html += '<td>' + row.position + '</td>';
                    html += '<td>' + (row.score != null ? row.score.toFixed(1) : '-') + '</td>';
                    html += '<td>' + row.available + '</td>';
                    html += '<td>' + row.maxConcurrency + '</td>';
                    html += '<td>' + (row.cost != null ? '$' + row.cost : '-') + '</td>';
                    html += '<td>' + row.hitCount + '</td>';
                    html += '<td>' + (row.selected ? 'SELECTED' : '') + '</td>';
                    html += '</tr>';
                }
                html += '</tbody></table>';
            }

            // Cooldown reasons
            if (data.cooldownReasons && data.cooldownReasons.length > 0) {
                html += '<div class="explain-cooldowns"><strong>Cooldowns:</strong><ul>';
                for (let j = 0; j < data.cooldownReasons.length; j++) {
                    const cd = data.cooldownReasons[j];
                    html += '<li>' + escapeHtml(cd.model) + ': ' + Math.ceil(cd.remainingMs / 1000) + 's remaining';
                    if (cd.burstDampened) html += ' (burst dampened)';
                    html += '</li>';
                }
                html += '</ul></div>';
            }

            // Matched rule or classifier result
            if (data.matchedRule) {
                html += '<div class="explain-match"><strong>Matched Rule:</strong> <code>' + escapeHtml(JSON.stringify(data.matchedRule)) + '</code></div>';
            } else if (data.classifierResult) {
                html += '<div class="explain-match"><strong>Classifier:</strong> tier=' + escapeHtml(data.classifierResult.tier) + ', reason=' + escapeHtml(data.classifierResult.reason) + '</div>';
            }

            // Request features
            if (data.features) {
                html += '<details class="explain-features"><summary>Request Features</summary>';
                html += '<pre>' + escapeHtml(JSON.stringify(data.features, null, 2)) + '</pre>';
                html += '</details>';
            }

            // Migration preview
            if (data.migrationPreview) {
                html += '<details class="explain-migration"><summary>Migration Preview</summary>';
                html += '<pre>' + escapeHtml(JSON.stringify(data.migrationPreview, null, 2)) + '</pre>';
                html += '</details>';
            }

            html += '</div>';
            container.innerHTML = html;
        }

        async function resetModelRouting() {
            try {
                const res = await fetch('/model-routing/reset', { method: 'POST' });
                if (res.ok) {
                    const result = await res.json().catch(() => ({}));
                    if (result.warning === 'runtime_only_change') {
                        showToast('Model routing reset (runtime only — not persisted to disk)', 'warning');
                    } else if (result.persisted === true) {
                        showToast('Model routing reset and persisted to disk', 'success');
                    } else {
                        showToast('Model routing reset', 'success');
                    }
                    fetchModelRouting();
                } else {
                    showToast('Failed to reset model routing', 'error');
                }
            } catch (err) {
                showToast('Failed to reset: ' + err.message, 'error');
            }
        }

        function copyRoutingJson() {
            if (!modelRoutingData) {
                showToast('No routing data available', 'warning');
                return;
            }
            const json = JSON.stringify(modelRoutingData, null, 2);
            navigator.clipboard.writeText(json).then(() => {
                showToast('Routing JSON copied to clipboard', 'success');
            }).catch(() => {
                // Fallback for non-HTTPS contexts
                const textarea = document.createElement('textarea');
                textarea.value = json;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                showToast('Routing JSON copied to clipboard', 'success');
            });
        }

        function exportRoutingJson() {
            try {
                const res = fetch('/model-routing/export');
                res.then(r => r.blob()).then(blob => {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'model-routing-export-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    showToast('Routing export downloaded', 'success');
                });
            } catch (err) {
                showToast('Export failed: ' + err.message, 'error');
            }
        }

        // Toggle collapsible sections
        document.addEventListener('click', function(e) {
            const toggle = e.target.closest('.routing-section-toggle');
            if (toggle) {
                const targetId = toggle.getAttribute('data-toggle');
                const content = document.getElementById(targetId);
                if (content) {
                    toggle.classList.toggle('open');
                    content.classList.toggle('open');
                    // Start/stop cooldown refresh
                    if (content.classList.contains('open')) {
                        startRoutingCooldownRefresh();
                    } else {
                        stopRoutingCooldownRefresh();
                    }
                }
            }
        });

        // ========== ROUTING OBSERVABILITY ==========

        const ROUTING_TIME_MINUTES = { '5m': 5, '1h': 60, '24h': 1440 };
        let routingObsTimeRange = '5m';

        function updateRoutingObsKPIs(history) {
            const statusEl = document.getElementById('routingObsStatus');
            const kpisEl = document.querySelector('.routing-obs-kpis');
            const hasData = history?.points?.length > 0;
            const routingDisabled = modelRoutingData !== null && !modelRoutingData.enabled;

            // Show contextual status message
            if (statusEl) {
                if (routingDisabled && !hasData) {
                    statusEl.textContent = 'Model routing is disabled. Enable routing to see observability data.';
                    statusEl.style.display = 'block';
                } else if (!hasData) {
                    statusEl.textContent = modelRoutingData === null
                        ? 'Routing config not loaded yet. Waiting for data...'
                        : 'No routing decisions recorded yet. Data appears as requests are processed.';
                    statusEl.style.display = 'block';
                } else {
                    statusEl.style.display = 'none';
                }
            }

            // Dim KPIs when no data
            if (kpisEl) {
                kpisEl.style.opacity = hasData ? '1' : routingDisabled ? '0.4' : '0.6';
            }

            if (!hasData) return;

            const pts = history.points;
            const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

            // Sum deltas over the window
            let totalDeltaSum = 0, burstDeltaSum = 0, failoverDeltaSum = 0;
            for (const p of pts) {
                totalDeltaSum += p.routing?.totalDelta || 0;
                burstDeltaSum += p.routing?.burstDelta || 0;
                failoverDeltaSum += p.routing?.failoverDelta || 0;
            }

            // Burst Share = burst / total over window
            const burstShare = totalDeltaSum > 0
                ? (burstDeltaSum / totalDeltaSum * 100).toFixed(1) + '%'
                : '0.0%';
            setVal('routingBurstShare', burstShare);

            // Failover Share = failover / total over window
            const failoverShare = totalDeltaSum > 0
                ? (failoverDeltaSum / totalDeltaSum * 100).toFixed(1) + '%'
                : '0.0%';
            setVal('routingFailoverShare', failoverShare);

            // 429/min from rateLimitedDelta (per-tick delta, NOT cumulative)
            const windowMinutes = ROUTING_TIME_MINUTES[routingObsTimeRange] || 5;
            const rateLimitedSum = pts.reduce((s, p) => s + (p.rateLimitedDelta || 0), 0);
            const perMin = windowMinutes > 0 ? (rateLimitedSum / windowMinutes).toFixed(1) : '0';
            setVal('routing429PerMin', perMin);

            // Decisions in window
            setVal('routingDecisionsInWindow', String(totalDeltaSum));
        }
        if (window.__DASHBOARD_DEBUG__) window.__DASHBOARD_DEBUG__.updateRoutingObsKPIs = updateRoutingObsKPIs;

        function updatePoolCooldownKPI(statsData) {
            const pool = statsData?.poolRateLimitStatus;
            const el = document.getElementById('routingPoolCooldown');
            if (!el) return;

            const routingEnabled = modelRoutingData?.enabled;
            if (!routingEnabled) {
                el.textContent = '—';
                return;
            }

            if (pool && pool.inCooldown) {
                el.textContent = Math.ceil(pool.remainingMs / 1000) + 's';
            } else {
                el.textContent = 'Idle';
            }
        }

        function updateRoutingDistributionCharts() {
            if (!modelRoutingData || !routingTierChart) return;
            const stats = modelRoutingData.stats || {};

            // Tier doughnut
            routingTierChart.data.datasets[0].data = [
                stats.byTier?.light || 0,
                stats.byTier?.medium || 0,
                stats.byTier?.heavy || 0
            ];
            routingTierChart.update('none');

            // Source doughnut (override + saved-override merged)
            const src = stats.bySource || {};
            routingSourceChart.data.datasets[0].data = [
                (src.override || 0) + (src['saved-override'] || 0),
                src.rule || 0,
                src.classifier || 0,
                src.default || 0,
                src.failover || 0
            ];
            routingSourceChart.update('none');
        }

        function updateRouting429Chart(history) {
            if (!history?.points?.length || !routing429Chart) return;
            // Limit to last 120 points to prevent chart overload
            const allPts = history.points;
            const pts = allPts.length > 120 ? allPts.slice(-120) : allPts;
            routing429Chart.data.labels = pts.map(p => formatTimestamp(p.timestamp));
            routing429Chart.data.datasets[0].data = pts.map(p => p.rateLimitedDelta || 0);
            routing429Chart.data.datasets[1].data = pts.map(p => p.routing?.burstDelta || 0);
            routing429Chart.update('none');
        }

        function startRoutingCooldownRefresh() {
            if (routingCooldownInterval) return;
            routingCooldownInterval = setInterval(fetchModelRouting, 5000);
        }

        function stopRoutingCooldownRefresh() {
            if (routingCooldownInterval) {
                clearInterval(routingCooldownInterval);
                routingCooldownInterval = null;
            }
        }