/**
 * context-menu.js — Context Menu Manager
 * Phase 6: Split from dashboard.js
 *
 * Provides: window.DashboardContextMenu
 * Handles right-click context menus on request rows with quick actions.
 */
(function(window) {
    'use strict';

    function ContextMenuManager() {
        this.menu = null;
        this.currentTarget = null;
        this.init();
    }

    ContextMenuManager.prototype.init = function() {
        var self = this;
        self.menu = document.getElementById('contextMenu');
        if (!self.menu) return;

        // Close on click outside
        document.addEventListener('click', function(e) {
            if (!self.menu.contains(e.target)) {
                self.hide();
            }
        });

        // Keyboard navigation: Escape to close, arrows to navigate
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                self.hide();
                return;
            }
            if (!self.menu || !self.menu.classList.contains('visible')) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                var items = Array.from(self.menu.querySelectorAll('[role="menuitem"]'));
                if (!items.length) return;
                var current = items.indexOf(document.activeElement);
                var next;
                if (e.key === 'ArrowDown') {
                    next = current < items.length - 1 ? current + 1 : 0;
                } else {
                    next = current > 0 ? current - 1 : items.length - 1;
                }
                items[next].focus();
            } else if (e.key === 'Enter' || e.key === ' ') {
                if (document.activeElement && document.activeElement.closest('#contextMenu')) {
                    e.preventDefault();
                    document.activeElement.click();
                }
            }
        });

        // Handle menu item clicks
        self.menu.querySelectorAll('.context-menu-item').forEach(function(item) {
            item.addEventListener('click', function() {
                var action = item.dataset.action;
                self.handleAction(action);
                self.hide();
            });
        });

        // Attach to request items via event delegation
        self.attachToItems();
    };

    ContextMenuManager.prototype.attachToItems = function() {
        var self = this;
        document.addEventListener('contextmenu', function(e) {
            var target = e.target.closest('.request-row, .request-item, .log-item, .trace-item, .key-item');
            if (target) {
                e.preventDefault();
                self.show(e.clientX, e.clientY, target);
            }
        });
    };

    ContextMenuManager.prototype.show = function(x, y, target) {
        this.currentTarget = target;
        this.menu.style.left = x + 'px';
        this.menu.style.top = y + 'px';
        this.menu.classList.add('visible');
        // Focus first item for keyboard accessibility
        var firstItem = this.menu.querySelector('[role="menuitem"]');
        if (firstItem) firstItem.focus();
    };

    ContextMenuManager.prototype.hide = function() {
        if (this.menu) {
            this.menu.classList.remove('visible');
        }
        this.currentTarget = null;
    };

    ContextMenuManager.prototype.handleAction = function(action) {
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
    };

    ContextMenuManager.prototype.copyId = function() {
        var id = this.currentTarget.dataset.id || this.currentTarget.dataset.traceId;
        if (id) {
            navigator.clipboard.writeText(id);
            if (typeof window.showToast === 'function') window.showToast('ID copied to clipboard');
        }
    };

    ContextMenuManager.prototype.filterByKey = function() {
        var keyId = this.currentTarget.dataset.keyId;
        if (keyId && window.filterManager) {
            window.filterManager.setFilter('keyId', keyId);
        }
    };

    ContextMenuManager.prototype.viewSimilar = function() {
        var model = this.currentTarget.dataset.model;
        if (model) {
            window.dispatchEvent(new CustomEvent('view-similar', { detail: { model: model } }));
        }
    };

    ContextMenuManager.prototype.investigateAnomaly = function() {
        window.dispatchEvent(new CustomEvent('investigate-anomaly', {
            detail: { element: this.currentTarget }
        }));
    };

    // ========== EXPORT ==========
    window.DashboardContextMenu = {
        ContextMenuManager: ContextMenuManager
    };

})(window);
