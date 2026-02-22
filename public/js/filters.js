/**
 * filters.js — Filter State, URL State, and Global Search Managers
 * Phase 6: Split from dashboard.js
 *
 * Provides: window.DashboardFilters
 * Contains: FilterStateManager, URLStateManager, GlobalSearchManager,
 * filter logic, model selection helpers, auto-scroll, copy to clipboard.
 */
(function(window) {
    'use strict';

    var DS = window.DashboardStore;
    var STATE = DS.STATE;
    var escapeHtml = DS.escapeHtml;
    var escapeRegex = DS.escapeRegex;
    var debounce = DS.debounce;
    var SEARCH_DEBOUNCE_DELAY = DS.SEARCH_DEBOUNCE_DELAY;
    var HISTORY_HIDE_DELAY = DS.HISTORY_HIDE_DELAY;

    // ========== FilterStateManager — Persistent Filters (UX #1) ==========
    function FilterStateManager() {
        this.filters = this.loadFromURL();
        this.filterChipsContainer = null;
    }

    FilterStateManager.prototype.loadFromURL = function() {
        var params = new URLSearchParams(window.location.search);
        return {
            status: params.get('status') || '',
            model: params.get('model') || '',
            keyId: params.get('keyId') || '',
            timeRange: params.get('timeRange') || ''
        };
    };

    FilterStateManager.prototype.saveToURL = function() {
        var params = new URLSearchParams();
        var self = this;
        Object.entries(self.filters).forEach(function(entry) {
            if (entry[1]) params.set(entry[0], entry[1]);
        });
        var path = window.location.pathname;
        var paramString = params.toString();
        var newURL = path + (paramString ? '?' + paramString : '');
        window.history.replaceState({}, '', newURL);
    };

    FilterStateManager.prototype.setFilter = function(key, value) {
        this.filters[key] = value;
        this.saveToURL();
        this.renderFilterChips();
        this.applyFilters();
    };

    FilterStateManager.prototype.removeFilter = function(key) {
        this.filters[key] = '';
        this.saveToURL();
        this.renderFilterChips();
        this.applyFilters();
    };

    FilterStateManager.prototype.renderFilterChips = function() {
        if (!this.filterChipsContainer) {
            this.filterChipsContainer = document.querySelector('.filter-chips-container');
            if (!this.filterChipsContainer) return;
        }

        this.filterChipsContainer.innerHTML = '';
        var filterLabels = {
            status: 'Status',
            model: 'Model',
            keyId: 'Key ID',
            timeRange: 'Time Range'
        };
        var self = this;

        Object.entries(self.filters).forEach(function(entry) {
            var key = entry[0], value = entry[1];
            if (value) {
                var chip = document.createElement('button');
                chip.className = 'filter-chip active';
                chip.type = 'button';
                chip.setAttribute('aria-label', 'Filter: ' + filterLabels[key] + ' is ' + value + '. Press to remove.');
                chip.setAttribute('data-filter-key', key);
                var label = filterLabels[key];
                chip.innerHTML = '<span>' + label + ': ' + value + '</span>' +
                    '<span class="filter-chip-remove" aria-hidden="true">\u2715</span>';
                chip.addEventListener('click', function() {
                    self.removeFilter(key);
                });
                chip.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        self.removeFilter(key);
                    }
                });
                self.filterChipsContainer.appendChild(chip);
            }
        });
    };

    FilterStateManager.prototype.applyFilters = function() {
        window.dispatchEvent(new CustomEvent('filters-changed', { detail: this.filters }));
    };

    FilterStateManager.prototype.init = function() {
        var self = this;
        self.renderFilterChips();
        window.addEventListener('popstate', function() {
            self.filters = self.loadFromURL();
            self.renderFilterChips();
            self.applyFilters();
        });
    };

    // ========== URLStateManager — Shareable URLs (UX #9) ==========
    function URLStateManager() {
        this.state = {};
        this.init();
    }

    URLStateManager.prototype.init = function() {
        var self = this;
        self.loadFromHash();
        window.addEventListener('hashchange', function() { self.loadFromHash(); });
    };

    URLStateManager.prototype.loadFromHash = function() {
        var hash = window.location.hash.slice(1);
        if (!hash) {
            this.state = {};
            return;
        }

        var params = new URLSearchParams(hash);
        this.state = {
            trace: params.get('trace') || null,
            compare: params.get('compare') || null,
            tab: params.get('tab') || null
        };

        if (this.state.trace) {
            this.openRequestDetails(this.state.trace);
        }
    };

    URLStateManager.prototype.setState = function(key, value) {
        this.state[key] = value;
        this.updateHash();
    };

    URLStateManager.prototype.updateHash = function() {
        var params = new URLSearchParams();
        Object.entries(this.state).forEach(function(entry) {
            if (entry[1]) params.set(entry[0], entry[1]);
        });
        window.location.hash = params.toString() ? params.toString() : '';
    };

    URLStateManager.prototype.getShareableURL = function() {
        return window.location.href;
    };

    URLStateManager.prototype.openRequestDetails = function(traceId) {
        window.dispatchEvent(new CustomEvent('open-request-details', { detail: { traceId: traceId } }));
    };

    // ========== GlobalSearchManager — Global Search (UX #7) ==========
    function GlobalSearchManager() {
        this.searchInput = null;
        this.historyDropdown = null;
        this.searchHistory = this.loadSearchHistory();
        this.currentMatchIndex = -1;
        this.matches = [];
        this.lastQuery = null;
        this.init();
    }

    GlobalSearchManager.prototype.init = function() {
        var self = this;
        self.searchInput = document.getElementById('globalSearchInput');
        self.historyDropdown = document.getElementById('searchHistoryDropdown');

        if (!self.searchInput) return;

        self.debouncedPerformSearch = debounce(function(query) {
            self.performSearch(query);
            self._setSearching(false);
        }, SEARCH_DEBOUNCE_DELAY);

        self.searchInput.addEventListener('input', function(e) { self.handleSearch(e.target.value); });
        self.searchInput.addEventListener('focus', function() { self.showHistory(); });
        self.searchInput.addEventListener('blur', function() {
            setTimeout(function() { self.hideHistory(); }, HISTORY_HIDE_DELAY);
        });

        document.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                self.searchInput.focus();
                self.searchInput.select();
            }
        });

        self.searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                self.hideHistory();
                self.searchInput.focus();
                return;
            }
            // Handle Enter key for command palette navigation
            if (e.key === 'Enter') {
                self.handleCommand(e.target.value);
                return;
            }
            // Arrow key navigation in dropdown
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && self.historyDropdown && self.historyDropdown.classList.contains('visible')) {
                e.preventDefault();
                self.navigateDropdown(e.key === 'ArrowDown' ? 1 : -1);
                return;
            }
        });

        // Handle Enter and Escape on focused dropdown items (roving tabindex keyboard activation)
        self.historyDropdown && self.historyDropdown.addEventListener('keydown', function(e) {
            var focused = document.activeElement;
            if (!focused || !self.historyDropdown.contains(focused)) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                focused.click();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                self.hideHistory();
                self.searchInput.focus();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                self.navigateDropdown(e.key === 'ArrowDown' ? 1 : -1);
            }
        });
    };

    GlobalSearchManager.prototype.navigateDropdown = function(direction) {
        var items = Array.from(this.historyDropdown.querySelectorAll('.search-history-item, .command-suggestion'));
        if (items.length === 0) return;

        var currentIndex = items.indexOf(document.activeElement);
        var nextIndex;

        if (currentIndex === -1) {
            // No item focused, go to first or last
            nextIndex = direction > 0 ? 0 : items.length - 1;
        } else {
            nextIndex = currentIndex + direction;
            if (nextIndex < 0) nextIndex = items.length - 1;
            if (nextIndex >= items.length) nextIndex = 0;
        }

        items[nextIndex].focus();
    };

    // Navigation command definitions
    var NAV_COMMANDS = [
        { pattern: /^(go\s*to\s*)?(overview|home)$/i, page: 'overview', subPage: null, label: 'Overview' },
        { pattern: /^(go\s*to\s*)?(requests?|req)$/i, page: 'requests', subPage: null, label: 'Requests' },
        { pattern: /^(go\s*to\s*)?(requests?\s*\/?\s*live|live\s*(stream)?)$/i, page: 'requests', subPage: 'live', label: 'Requests > Live' },
        { pattern: /^(go\s*to\s*)?(requests?\s*\/?\s*traces?|traces?)$/i, page: 'requests', subPage: 'traces', label: 'Requests > Traces' },
        { pattern: /^(go\s*to\s*)?(requests?\s*\/?\s*logs?|logs?)$/i, page: 'requests', subPage: 'logs', label: 'Requests > Logs' },
        { pattern: /^(go\s*to\s*)?(requests?\s*\/?\s*queue|queue)$/i, page: 'requests', subPage: 'queue', label: 'Requests > Queue' },
        { pattern: /^(go\s*to\s*)?(requests?\s*\/?\s*circuit|circuit)$/i, page: 'requests', subPage: 'circuit', label: 'Requests > Circuit' },
        { pattern: /^(go\s*to\s*)?(routing|model\s*routing|config(ure)?)$/i, page: 'routing', subPage: null, label: 'Model Routing' },
        { pattern: /^(go\s*to\s*)?(routing\s*\/?\s*observability|observability)$/i, page: 'routing', subPage: 'observability', label: 'Routing > Observability' },
        { pattern: /^(go\s*to\s*)?(routing\s*\/?\s*cooldowns?|cooldowns?)$/i, page: 'routing', subPage: 'cooldowns', label: 'Routing > Cooldowns' },
        { pattern: /^(go\s*to\s*)?(routing\s*\/?\s*overrides?|overrides?)$/i, page: 'routing', subPage: 'overrides', label: 'Routing > Overrides' },
        { pattern: /^(go\s*to\s*)?(routing\s*\/?\s*advanced|advanced)$/i, page: 'routing', subPage: 'advanced', label: 'Routing > Advanced' },
        { pattern: /^(go\s*to\s*)?(system|diagnostics?|diag)$/i, page: 'system', subPage: null, label: 'System / Diagnostics' }
    ];

    // Action command definitions
    var ACTION_COMMANDS = [
        { pattern: /^(export|download)$/i, action: 'export', label: 'Export data' },
        { pattern: /^(share|copy\s*url)$/i, action: 'share', label: 'Copy shareable link' },
        { pattern: /^(theme|toggle\s*theme|dark\s*mode|light\s*mode)$/i, action: 'theme', label: 'Toggle theme' },
        { pattern: /^(fullscreen|full\s*screen)$/i, action: 'fullscreen', label: 'Toggle fullscreen' },
        { pattern: /^(help|\?|shortcuts?|keyboard)$/i, action: 'help', label: 'Show keyboard shortcuts' },
        { pattern: /^(refresh|reload)$/i, action: 'refresh', label: 'Refresh data' },
        { pattern: /^(pause)$/i, action: 'pause', label: 'Pause proxy' },
        { pattern: /^(resume)$/i, action: 'resume', label: 'Resume proxy' }
    ];

    // Combined commands for suggestions
    var ALL_COMMANDS = NAV_COMMANDS.concat(ACTION_COMMANDS);

    GlobalSearchManager.prototype.handleCommand = function(query) {
        var trimmed = query.trim().toLowerCase();
        var self = this;

        // Check if it's a navigation command
        for (var i = 0; i < NAV_COMMANDS.length; i++) {
            var cmd = NAV_COMMANDS[i];
            if (cmd.pattern.test(trimmed)) {
                // Execute navigation
                var DI = window.DashboardInit;
                if (DI) {
                    DI.switchPage(cmd.page);
                    if (cmd.subPage) {
                        if (cmd.page === 'requests') {
                            DI.switchRequestTab(cmd.subPage);
                        } else if (cmd.page === 'routing') {
                            DI.switchRoutingTab(cmd.subPage);
                        }
                    }
                    // Clear search input and hide history
                    self.searchInput.value = '';
                    self.hideHistory();
                    self.clearHighlights();
                    if (window.showToast) {
                        window.showToast('Navigated to ' + cmd.label, 'success');
                    }
                }
                return true;
            }
        }

        // Check if it's an action command
        for (var j = 0; j < ACTION_COMMANDS.length; j++) {
            var actionCmd = ACTION_COMMANDS[j];
            if (actionCmd.pattern.test(trimmed)) {
                self.executeAction(actionCmd.action, actionCmd.label);
                self.searchInput.value = '';
                self.hideHistory();
                self.clearHighlights();
                return true;
            }
        }

        return false;
    };

    GlobalSearchManager.prototype.executeAction = function(action, label) {
        var DD = window.DashboardData;
        var DI = window.DashboardInit;

        switch (action) {
            case 'export':
                if (DD && DD.exportData) DD.exportData();
                break;
            case 'share':
                if (DD && DD.shareURL) DD.shareURL();
                break;
            case 'theme':
                if (DI && DI.toggleTheme) DI.toggleTheme();
                break;
            case 'fullscreen':
                if (DD && DD.toggleFullscreen) DD.toggleFullscreen();
                break;
            case 'help':
                if (DI && DI.showShortcutsModal) DI.showShortcutsModal();
                break;
            case 'refresh':
                if (DD && DD.fetchStats) DD.fetchStats();
                if (window.showToast) window.showToast('Data refreshed', 'success');
                break;
            case 'pause':
                if (DD && DD.controlAction) DD.controlAction('pause');
                break;
            case 'resume':
                if (DD && DD.controlAction) DD.controlAction('resume');
                break;
        }
    };

    GlobalSearchManager.prototype.handleSearch = function(query) {
        if (!query.trim()) {
            this.clearHighlights();
            this._setSearching(false);
            return;
        }

        var trimmed = query.trim().toLowerCase();

        // Check for navigation command prefix (e.g., "go to", ">", "/")
        if (trimmed.startsWith('go to') || trimmed.startsWith('/') || trimmed.startsWith('>')) {
            // Show command suggestions instead of regular search
            this.showCommandSuggestions(query);
            return;
        }

        // Check if the query matches an action command directly
        for (var i = 0; i < ACTION_COMMANDS.length; i++) {
            if (ACTION_COMMANDS[i].pattern.test(trimmed)) {
                this.showCommandSuggestions(query);
                return;
            }
        }

        if (query === this.lastQuery) return;
        this.lastQuery = query;
        this.saveSearch(query);
        this._setSearching(true);
        this.debouncedPerformSearch(query);
    };

    GlobalSearchManager.prototype.showCommandSuggestions = function(query) {
        var self = this;
        var trimmed = query.trim().toLowerCase();

        // Filter matching commands from both navigation and action commands
        var matches = ALL_COMMANDS.filter(function(cmd) {
            return cmd.pattern.test(trimmed);
        });

        // Also do fuzzy matching for partial input
        if (matches.length === 0) {
            var searchTerm = trimmed.replace(/^(go\s*to\s*|\/|>)/, '').trim();
            // If we have a command prefix but no search term, show all commands
            if (!searchTerm && (trimmed.startsWith('go to') || trimmed.startsWith('/') || trimmed.startsWith('>'))) {
                matches = ALL_COMMANDS.slice(0, 8); // Show first 8 commands (nav + actions)
            } else if (searchTerm) {
                matches = ALL_COMMANDS.filter(function(cmd) {
                    return cmd.label.toLowerCase().indexOf(searchTerm) !== -1;
                });
            }
        }

        if (!this.historyDropdown) return;

        this.historyDropdown.innerHTML = '';

        if (matches.length > 0) {
            matches.slice(0, 8).forEach(function(cmd) {
                var item = document.createElement('div');
                item.className = 'search-history-item command-suggestion';
                item.setAttribute('role', 'option');
                item.setAttribute('tabindex', '-1');
                item.setAttribute('aria-selected', 'false');
                item.innerHTML = '<span class="command-icon">↪</span> ' + DS.escapeHtml(cmd.label);
                item.addEventListener('click', function() {
                    self.searchInput.value = '';
                    self.hideHistory();

                    // Check if it's a navigation command or action command
                    if (cmd.page) {
                        // Navigation command
                        var DI = window.DashboardInit;
                        if (DI) {
                            DI.switchPage(cmd.page);
                            if (cmd.subPage) {
                                if (cmd.page === 'requests') {
                                    DI.switchRequestTab(cmd.subPage);
                                } else if (cmd.page === 'routing') {
                                    DI.switchRoutingTab(cmd.subPage);
                                }
                            }
                            if (window.showToast) {
                                window.showToast('Navigated to ' + cmd.label, 'success');
                            }
                        }
                    } else if (cmd.action) {
                        // Action command
                        self.executeAction(cmd.action, cmd.label);
                    }
                });
                self.historyDropdown.appendChild(item);
            });
            this.historyDropdown.classList.add('visible');
            if (this.searchInput) {
                this.searchInput.setAttribute('aria-expanded', 'true');
            }
        } else {
            this.historyDropdown.classList.remove('visible');
            if (this.searchInput) {
                this.searchInput.setAttribute('aria-expanded', 'false');
            }
        }
    };

    GlobalSearchManager.prototype._setSearching = function(isSearching) {
        var indicator = document.getElementById('searchingIndicator');
        if (indicator) {
            indicator.style.display = isSearching ? 'inline' : 'none';
        }
    };

    GlobalSearchManager.prototype.performSearch = function(query) {
        this._setSearching(true);
        var escaped = escapeRegex(query);
        var regex = new RegExp(escaped, 'gi');
        this.matches = [];
        var maxScanned = 1000;
        var scanned = 0;
        var self = this;

        document.querySelectorAll('.request-row, .request-item, .log-item, .trace-item').forEach(function(item) {
            if (scanned >= maxScanned) {
                console.warn('[GlobalSearch] Limited to', maxScanned, 'elements for performance');
                return;
            }
            scanned++;
            var text = item.textContent;
            if (regex.test(text)) {
                self.matches.push(item);
            }
        });

        if (window.__DASHBOARD_DEBUG__?.search) {
            window.__DASHBOARD_DEBUG__.search.runs++;
            window.__DASHBOARD_DEBUG__.search.lastQuery = query;
        }

        this.highlightMatches(regex);
    };

    GlobalSearchManager.prototype.highlightMatches = function(regex) {
        this.clearHighlights();
        this.matches.forEach(function(item) {
            var walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, null, false);
            var nodesToReplace = [];
            var node;
            while (node = walker.nextNode()) {
                if (regex.test(node.textContent)) {
                    nodesToReplace.push(node);
                }
            }

            nodesToReplace.forEach(function(node) {
                var text = node.textContent;
                var fragment = document.createDocumentFragment();
                var lastIndex = 0;
                regex.lastIndex = 0;
                var match;
                while ((match = regex.exec(text)) !== null) {
                    if (match.index > lastIndex) {
                        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                    }
                    var mark = document.createElement('mark');
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

        if (this.matches.length > 0) {
            this.matches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    };

    GlobalSearchManager.prototype.clearHighlights = function() {
        document.querySelectorAll('.search-highlight').forEach(function(mark) {
            var parent = mark.parentNode;
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parent.normalize();
        });
    };

    GlobalSearchManager.prototype.showHistory = function() {
        if (!this.historyDropdown) return;
        var self = this;
        self.historyDropdown.innerHTML = '';
        self.searchHistory.forEach(function(query) {
            var item = document.createElement('div');
            item.className = 'search-history-item';
            item.setAttribute('role', 'option');
            item.setAttribute('tabindex', '-1');
            item.setAttribute('aria-selected', 'false');
            item.textContent = query;
            item.addEventListener('click', function() {
                self.searchInput.value = query;
                self.handleSearch(query);
                self.hideHistory();
            });
            self.historyDropdown.appendChild(item);
        });
        self.historyDropdown.classList.add('visible');
        if (self.searchInput) {
            self.searchInput.setAttribute('aria-expanded', 'true');
        }
    };

    GlobalSearchManager.prototype.hideHistory = function() {
        if (this.historyDropdown) {
            this.historyDropdown.classList.remove('visible');
        }
        if (this.searchInput) {
            this.searchInput.setAttribute('aria-expanded', 'false');
        }
    };

    GlobalSearchManager.prototype.loadSearchHistory = function() {
        var stored = localStorage.getItem('dashboard-search-history');
        return stored ? JSON.parse(stored) : [];
    };

    GlobalSearchManager.prototype.saveSearch = function(query) {
        if (!query.trim()) return;
        this.searchHistory = this.searchHistory.filter(function(q) { return q !== query; });
        this.searchHistory.unshift(query);
        this.searchHistory = this.searchHistory.slice(0, 10);
        localStorage.setItem('dashboard-search-history', JSON.stringify(this.searchHistory));
    };

    // ========== FILTER LOGIC ==========
    STATE.selectedListIndex = -1;
    STATE.filters = { status: '', key: '', model: '' };

    /**
     * getFilteredRequests — returns the filtered view of STATE.requestsHistory.
     * Used by the virtual scroll renderer in sse.js so that filtering is
     * data-driven rather than DOM-driven (fixes filter state destroyed on scroll).
     */
    function getFilteredRequests() {
        var items = STATE.requestsHistory;
        var f = STATE.filters;
        if (!f.status && !f.key && !f.model) return items;

        return items.filter(function(req) {
            if (f.status) {
                var rowStatus = req.error ? 'error' : req.status === 'completed' ? 'success' : 'pending';
                if (rowStatus !== f.status) return false;
            }
            if (f.key && String(req.keyIndex ?? '') !== f.key) return false;
            if (f.model) {
                var model = req.originalModel || req.mappedModel || '';
                if (!model.includes(f.model)) return false;
            }
            return true;
        });
    }

    /**
     * updateFilterCount — updates the filter count badge to show filtered/total.
     */
    function updateFilterCount(filteredCount, totalCount) {
        var countEl = document.getElementById('filterCount');
        if (countEl) {
            if (filteredCount < totalCount) {
                countEl.textContent = filteredCount + '/' + totalCount;
                countEl.style.display = '';
            } else {
                countEl.textContent = '';
                countEl.style.display = 'none';
            }
        }
    }

    function applyFilters() {
        var statusFilter = document.getElementById('filterStatus')?.value || '';
        var keyFilter = document.getElementById('filterKey')?.value || '';
        var modelFilter = document.getElementById('filterModel')?.value || '';

        STATE.filters = { status: statusFilter, key: keyFilter, model: modelFilter };

        // Reset scroll position
        var viewport = document.querySelector('.virtual-scroll-viewport');
        if (viewport) viewport.scrollTop = 0;

        // Update filter count display
        var filtered = getFilteredRequests();
        var total = STATE.requestsHistory.length;
        updateFilterCount(filtered.length, total);

        // Trigger virtual re-render with filtered data
        if (window.DashboardSSE?.scheduleVirtualRender) {
            window.DashboardSSE.scheduleVirtualRender();
        }

        // Clear selection since filtered set changed
        clearRequestListSelection();
    }

    function clearFilters() {
        var filterStatus = document.getElementById('filterStatus');
        var filterKey = document.getElementById('filterKey');
        var filterModel = document.getElementById('filterModel');
        if (filterStatus) filterStatus.value = '';
        if (filterKey) filterKey.value = '';
        if (filterModel) filterModel.value = '';
        STATE.filters = { status: '', key: '', model: '' };

        // Update filter count display (no filter active = hide badge)
        updateFilterCount(STATE.requestsHistory.length, STATE.requestsHistory.length);

        // Trigger virtual re-render with unfiltered data
        if (window.DashboardSSE?.scheduleVirtualRender) {
            window.DashboardSSE.scheduleVirtualRender();
        }

        clearRequestListSelection();
        if (typeof window.showToast === 'function') window.showToast('Filters cleared', 'info');
    }

    function populateFilterOptions() {
        var keySelect = document.getElementById('filterKey');
        if (keySelect && STATE.keys.data) {
            var currentValue = keySelect.value;
            keySelect.innerHTML = '<option value="">All Keys</option>';
            STATE.keys.data.forEach(function(key, index) {
                var option = document.createElement('option');
                option.value = index.toString();
                option.textContent = 'Key ' + index;
                keySelect.appendChild(option);
            });
            keySelect.value = currentValue;
        }
        populateModelFilter();
    }

    function populateModelFilter() {
        var modelSelect = document.getElementById('filterModel');
        if (!modelSelect) return;

        var currentValue = modelSelect.value;
        var models = new Set();

        if (STATE.models && STATE.models.length > 0) {
            STATE.models.forEach(function(model) { models.add(model); });
        }
        STATE.requestsHistory.forEach(function(r) {
            if (r.mappedModel) models.add(r.mappedModel);
        });

        modelSelect.innerHTML = '<option value="">All Models</option>';
        Array.from(models).sort().forEach(function(modelId) {
            var option = document.createElement('option');
            option.value = modelId;
            var modelData = STATE.modelsData && STATE.modelsData[modelId];
            var displayName = modelData && modelData.displayName ? modelData.displayName : modelId;
            var tier = modelData && modelData.tier ? ' [' + modelData.tier + ']' : '';
            option.textContent = displayName.length > 30 ? displayName.slice(0, 30) + '...' + tier : displayName + tier;
            modelSelect.appendChild(option);
        });
        modelSelect.value = currentValue;
    }

    // ========== MODEL SELECTION HELPERS ==========
    function createModelSelectElement(options) {
        options = options || {};
        var id = options.id || 'modelSelect';
        var className = options.className || 'filter-select';
        var placeholder = options.placeholder || 'Select a model';
        var includeAllOption = options.includeAllOption !== false;
        var selectedValue = options.selectedValue || '';

        var select = document.createElement('select');
        select.id = id;
        select.className = className;

        if (includeAllOption) {
            var allOption = document.createElement('option');
            allOption.value = '';
            allOption.textContent = placeholder || 'All Models';
            select.appendChild(allOption);
        }

        var models = new Set();
        if (STATE.models && STATE.models.length > 0) {
            STATE.models.forEach(function(model) { models.add(model); });
        }
        STATE.requestsHistory.forEach(function(r) {
            if (r.mappedModel) models.add(r.mappedModel);
        });

        Array.from(models).sort().forEach(function(model) {
            var option = document.createElement('option');
            option.value = model;
            option.textContent = model;
            if (selectedValue && model === selectedValue) {
                option.selected = true;
            }
            select.appendChild(option);
        });

        return select;
    }

    function getAvailableModels() {
        var models = new Set();
        if (STATE.models && STATE.models.length > 0) {
            STATE.models.forEach(function(model) { models.add(model); });
        }
        return Array.from(models).sort();
    }

    // ========== REQUEST LIST NAVIGATION ==========
    function navigateRequestList(direction) {
        var rows = document.querySelectorAll('#liveStreamRequestList .request-row');
        if (rows.length === 0) return;

        // Find current selection in rendered rows
        var currentIndex = -1;
        rows.forEach(function(row, i) {
            if (row.classList.contains('selected')) currentIndex = i;
        });

        var nextIndex = currentIndex + direction;
        if (nextIndex < 0) nextIndex = rows.length - 1;
        if (nextIndex >= rows.length) nextIndex = 0;

        // Remove old selection
        rows.forEach(function(row) { row.classList.remove('selected'); });

        // Apply new selection
        var targetRow = rows[nextIndex];
        if (targetRow) {
            targetRow.classList.add('selected');
            targetRow.scrollIntoView({ block: 'nearest' });
            STATE.selectedRequestId = targetRow.dataset.requestId || null;
            STATE.selectedListIndex = nextIndex;
        }
    }

    function clearRequestListSelection() {
        STATE.selectedListIndex = -1;
        document.querySelectorAll('#liveStreamRequestList .request-row.selected').forEach(function(r) { r.classList.remove('selected'); });
    }

    // ========== AUTO-SCROLL TOGGLE ==========
    function toggleAutoScroll() {
        STATE.settings.autoScroll = !STATE.settings.autoScroll;
        var btn = document.getElementById('autoScrollToggle');
        if (btn) {
            btn.classList.toggle('active', STATE.settings.autoScroll);
            btn.title = 'Toggle auto-scroll (' + (STATE.settings.autoScroll ? 'on' : 'off') + ')';
        }
        if (typeof window.showToast === 'function') window.showToast('Auto-scroll ' + (STATE.settings.autoScroll ? 'enabled' : 'disabled'), 'info');
    }

    function jumpToLatest() {
        var viewport = document.querySelector('.virtual-scroll-viewport');
        if (viewport) {
            viewport.scrollTop = 0;
            if (typeof window.showToast === 'function') window.showToast('Jumped to latest', 'info');
        }
    }

    // ========== COPY TO CLIPBOARD ==========
    function copyToClipboard(text, btn) {
        navigator.clipboard.writeText(text).then(function() {
            if (btn) {
                var originalText = btn.textContent;
                btn.textContent = '\u2713';
                btn.classList.add('copied');
                setTimeout(function() {
                    btn.textContent = originalText;
                    btn.classList.remove('copied');
                }, 1500);
            }
            if (typeof window.showToast === 'function') window.showToast('Copied to clipboard', 'success');
        }).catch(function() {
            if (typeof window.showToast === 'function') window.showToast('Failed to copy', 'error');
        });
    }

    // ========== FILTER INITIALIZATION ==========
    function initFilterListeners() {
        var filterStatus = document.getElementById('filterStatus');
        var filterKey = document.getElementById('filterKey');
        var filterModel = document.getElementById('filterModel');
        var tenantSelect = document.getElementById('tenantSelect');

        if (filterStatus) filterStatus.addEventListener('change', applyFilters);
        if (filterKey) filterKey.addEventListener('change', applyFilters);
        if (filterModel) filterModel.addEventListener('change', applyFilters);
        if (tenantSelect) tenantSelect.addEventListener('change', function(e) {
            if (window.DashboardInit?.selectTenant) {
                window.DashboardInit.selectTenant(e.target.value);
            }
        });

        var autoScrollBtn = document.getElementById('autoScrollToggle');
        if (autoScrollBtn) {
            autoScrollBtn.classList.toggle('active', STATE.settings.autoScroll !== false);
        }

        setTimeout(populateFilterOptions, 2000);
    }

    // ========== EXPORT ==========
    window.DashboardFilters = {
        FilterStateManager: FilterStateManager,
        URLStateManager: URLStateManager,
        GlobalSearchManager: GlobalSearchManager,
        getFilteredRequests: getFilteredRequests,
        updateFilterCount: updateFilterCount,
        applyFilters: applyFilters,
        clearFilters: clearFilters,
        populateFilterOptions: populateFilterOptions,
        populateModelFilter: populateModelFilter,
        createModelSelectElement: createModelSelectElement,
        getAvailableModels: getAvailableModels,
        navigateRequestList: navigateRequestList,
        clearRequestListSelection: clearRequestListSelection,
        toggleAutoScroll: toggleAutoScroll,
        jumpToLatest: jumpToLatest,
        copyToClipboard: copyToClipboard,
        initFilterListeners: initFilterListeners
    };

})(window);
