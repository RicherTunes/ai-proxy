/**
 * progressive-disclosure.js — Progressive Disclosure Manager
 * Phase 6: Split from dashboard.js
 *
 * Provides: window.DashboardProgressive
 * Handles collapsible sections for progressive disclosure of complex data.
 */
(function(window) {
    'use strict';

    var escapeHtml = window.DashboardStore ? window.DashboardStore.escapeHtml : function(str) {
        if (str === null || str === undefined) return '';
        var div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    };

    function ProgressiveDisclosureManager() {
        this._abortController = null;
        this.init();
    }

    ProgressiveDisclosureManager.prototype.init = function() {
        var self = this;

        // Abort any previous listeners before attaching new ones
        if (self._abortController) {
            self._abortController.abort();
        }
        self._abortController = new AbortController();
        var signal = self._abortController.signal;

        // Attach to all collapsible sections
        document.querySelectorAll('.collapsible-header').forEach(function(header) {
            // Named click handler
            header.addEventListener('click', self._makeClickHandler(header), { signal: signal });

            // Named keyboard handler for accessibility
            header.addEventListener('keydown', self._makeKeydownHandler(header), { signal: signal });
        });

        // Restore collapsed state from localStorage
        self.restoreCollapseState();
    };

    ProgressiveDisclosureManager.prototype._makeClickHandler = function(header) {
        var self = this;
        return function() {
            self.toggleSection(header);
        };
    };

    ProgressiveDisclosureManager.prototype._makeKeydownHandler = function(header) {
        var self = this;
        return function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                self.toggleSection(header);
            }
        };
    };

    ProgressiveDisclosureManager.prototype.toggleSection = function(header) {
        var section = header.closest('.collapsible-section');
        if (!section) return;

        var isCollapsed = section.classList.toggle('collapsed');
        var sectionId = section.id;

        // Update ARIA state
        header.setAttribute('aria-expanded', !isCollapsed);

        // Save state to localStorage
        if (sectionId) {
            try {
                var state = JSON.parse(localStorage.getItem('dashboard-collapsible-state') || '{}');
                state[sectionId] = isCollapsed;
                localStorage.setItem('dashboard-collapsible-state', JSON.stringify(state));
            } catch (e) {
                // Ignore storage errors
            }
        }
    };

    ProgressiveDisclosureManager.prototype.restoreCollapseState = function() {
        try {
            var state = JSON.parse(localStorage.getItem('dashboard-collapsible-state') || '{}');
            Object.keys(state).forEach(function(sectionId) {
                var section = document.getElementById(sectionId);
                if (section && section.classList.contains('collapsible-section')) {
                    var header = section.querySelector('.collapsible-header');
                    if (state[sectionId]) {
                        section.classList.add('collapsed');
                        if (header) header.setAttribute('aria-expanded', 'false');
                    } else {
                        section.classList.remove('collapsed');
                        if (header) header.setAttribute('aria-expanded', 'true');
                    }
                }
            });
        } catch (e) {
            // Ignore storage errors
        }
    };

    ProgressiveDisclosureManager.prototype.createCollapsible = function(title, content, collapsed) {
        if (collapsed === undefined) collapsed = false;
        var self = this;
        var section = document.createElement('div');
        section.className = 'collapsible-section' + (collapsed ? ' collapsed' : '');

        section.innerHTML =
            '<div class="collapsible-header" role="button" tabindex="0" aria-expanded="' + !collapsed + '">' +
                '<div class="collapsible-header-title">' +
                    '<span>' + escapeHtml(title) + '</span>' +
                '</div>' +
                '<svg class="collapsible-chevron" viewBox="0 0 20 20">' +
                    '<path d="M10 14l-5-5h10l-5 5z"/>' +
                '</svg>' +
            '</div>' +
            '<div class="collapsible-content">' +
                content +
            '</div>';

        // Attach handlers (use AbortController signal for cleanup)
        var header = section.querySelector('.collapsible-header');
        var signal = self._abortController ? self._abortController.signal : undefined;
        var opts = signal ? { signal: signal } : {};
        header.addEventListener('click', self._makeClickHandler(header), opts);
        header.addEventListener('keydown', self._makeKeydownHandler(header), opts);

        return section;
    };

    ProgressiveDisclosureManager.prototype.destroy = function() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
    };

    // ========== EXPORT ==========
    window.DashboardProgressive = {
        ProgressiveDisclosureManager: ProgressiveDisclosureManager
    };

})(window);
