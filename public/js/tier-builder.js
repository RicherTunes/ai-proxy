/**
 * tier-builder.js — Tier Builder (Drag-and-Drop) + Routing Functions
 * Phase 6: Split from dashboard.js
 *
 * Provides: window.DashboardTierBuilder
 * Contains: TierBuilder class, withLoading helper, saveTierConfig,
 * routing rules, per-model usage, explain routing, routing test,
 * model routing fetch, routing observability.
 */
(function(window) {
    'use strict';

    var DS = window.DashboardStore;
    var STATE = DS.STATE;
    var FEATURES = DS.FEATURES;
    var escapeHtml = DS.escapeHtml;
    var formatTimestamp = DS.formatTimestamp;
    var renderEmptyState = DS.renderEmptyState;
    var TIME_RANGES = DS.TIME_RANGES;
    var showToast = window.showToast;

    // Module-level state
    var modelRoutingData = null;
    var routingCooldownInterval = null;

    // ========== HELPER: withLoading ==========
    async function withLoading(btn, fn, options) {
        options = options || {};
        var busyText = options.busyText || 'Saving...';
        var originalText = btn.textContent;
        var originalDisabled = btn.disabled;

        try {
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            btn.textContent = busyText;
            if (window.__DASHBOARD_DEBUG__) window.__DASHBOARD_DEBUG__.loading.inFlight++;
            return await fn();
        } catch (error) {
            btn.textContent = 'Failed';
            setTimeout(function() {
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
            if (window.__DASHBOARD_DEBUG__) window.__DASHBOARD_DEBUG__.loading.inFlight--;
        }
    }

    // ========== TIER BUILDER CLASS ==========
    function TierBuilder() {
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

        this.serverState = null;
        this.sortables = {};
        this._saveDebounceTimer = null;
        this._destroyed = false;

        var self = this;
        this._onSave = function() { self.save(); };
        this._onReset = function() { self.reset(); };
        this._onStrategyChange = function() { self._computePendingChanges(); };

        if (this.saveBtn) this.saveBtn.addEventListener('click', this._onSave);
        if (this.resetBtn) this.resetBtn.addEventListener('click', this._onReset);

        Object.values(this.strategySelects).forEach(function(sel) {
            if (sel) sel.addEventListener('change', self._onStrategyChange);
        });

        // Tooltip delegation — store refs for cleanup in destroy()
        this._onMouseEnter = function(e) {
            var card = e.target.closest('.model-card');
            if (card && card.dataset.modelId) self._showTooltip(card, card.dataset.modelId);
        };
        this._onMouseLeave = function(e) {
            var card = e.target.closest('.model-card');
            if (card) self._hideTooltip();
        };
        this._onFocusIn = function(e) {
            var card = e.target.closest('.model-card');
            if (card && card.dataset.modelId) {
                self._showTooltip(card, card.dataset.modelId);
                // Link tooltip to card for screen readers
                card.setAttribute('aria-describedby', 'modelCardTooltip');
            }
        };
        this._onFocusOut = function(e) {
            var card = e.target.closest('.model-card');
            if (card) {
                self._hideTooltip();
                card.removeAttribute('aria-describedby');
            }
        };
        this._onKeyDown = function(e) {
            if (e.key === 'Escape') {
                self._hideTooltip();
                // Also remove aria-describedby from any card
                self.container.querySelectorAll('.model-card[aria-describedby]').forEach(function(card) {
                    card.removeAttribute('aria-describedby');
                });
            }
        };
        if (this.container) {
            this.container.addEventListener('mouseenter', this._onMouseEnter, true);
            this.container.addEventListener('mouseleave', this._onMouseLeave, true);
            this.container.addEventListener('focusin', this._onFocusIn);
            this.container.addEventListener('focusout', this._onFocusOut);
            this.container.addEventListener('keydown', this._onKeyDown);
        }
    }

    TierBuilder.prototype.render = function(routingData, modelsData, availableModels) {
        if (!this.container) return;
        this.serverState = this._extractTierState(routingData);
        this._destroySortables();
        this._renderUpgradeInfo(routingData);
        // Save bank state for sort/re-render
        this._bankModels = availableModels.slice();
        this._modelsData = modelsData;
        this._bankSort = this._bankSort || 'name';

        this._renderBank(availableModels, modelsData);

        // Reapply current sort order
        if (this._bankSort && this._bankSort !== 'name') {
            this.sortBank(this._bankSort);
        }

        // Sync sort dropdown UI
        var sortEl = document.getElementById('modelsBankSort');
        if (sortEl) sortEl.value = this._bankSort || 'name';

        var tiers = routingData?.config?.tiers || {};
        var self = this;
        Object.entries(this.lanes).forEach(function(entry) {
            var tierName = entry[0], lane = entry[1];
            if (!lane) return;
            var tierConfig = tiers[tierName];
            var models = self._getTierModels(tierConfig);
            self._renderLane(lane, tierName, models, modelsData);
            var stratSel = self.strategySelects[tierName];
            if (stratSel && tierConfig) {
                stratSel.value = tierConfig.strategy || 'balanced';
            }
        });

        this._initSortable();
        this._updatePositions();
        this._detectSharedModels();
        this._computePendingChanges();
        this.updateShadowBadges(routingData?.config);
    };

    TierBuilder.prototype._renderUpgradeInfo = function(routingData) {
        var panel = document.getElementById('upgradeInfoPanel');
        if (panel) panel.remove();

        var thresholds = routingData?.config?.complexityUpgrade?.thresholds
            || routingData?.config?.classifier?.heavyThresholds;
        if (!thresholds) return;

        panel = document.createElement('div');
        panel.id = 'upgradeInfoPanel';
        panel.className = 'upgrade-info-panel';

        var toggle = document.createElement('button');
        toggle.className = 'upgrade-info-toggle';
        toggle.setAttribute('data-action', 'toggle-upgrade-info');
        toggle.innerHTML = '<span>Why upgrade to Heavy tier?</span><span class="chevron">\u25BC</span>';

        var content = document.createElement('div');
        content.className = 'upgrade-info-content';
        content.id = 'upgradeInfoContent';
        content.innerHTML = '<p>Sonnet and Opus requests upgrade to Heavy tier via scoped rules when:</p>' +
            '<ul class="upgrade-triggers-list">' +
            '<li>' + escapeHtml('Has tools') + ' - Request includes function calling</li>' +
            '<li>' + escapeHtml('Has vision') + ' - Request includes images</li>' +
            '<li>' + escapeHtml('Max tokens \u2265 ' + (thresholds.maxTokensGte || thresholds.maxTokens || '4096')) + ' - Large token requests</li>' +
            '<li>' + escapeHtml('Messages \u2265 ' + (thresholds.messageCountGte || thresholds.messageCount || '20')) + ' - Long conversations</li>' +
            '<li>' + escapeHtml('System \u2265 ' + (thresholds.systemLengthGte || thresholds.systemLength || '2000') + ' chars') + ' - Long system prompts</li>' +
            '</ul>' +
            '<p class="upgrade-info-note">Upgrades are driven by scoped rules (Sonnet/Opus only). Haiku requests stay in their assigned tier. Env var thresholds (<code>GLM_COMPLEXITY_UPGRADE_*</code>) provide telemetry classification.</p>';

        panel.appendChild(toggle);
        panel.appendChild(content);

        if (this.container) {
            this.container.insertBefore(panel, this.container.firstChild);
        }

        toggle.addEventListener('click', function() {
            var isExpanded = content.classList.contains('expanded');
            content.classList.toggle('expanded');
            toggle.classList.toggle('expanded');
        });
    };

    TierBuilder.prototype._extractTierState = function(routingData) {
        var tiers = routingData?.config?.tiers || {};
        var state = {};
        var self = this;
        Object.entries(tiers).forEach(function(entry) {
            var name = entry[0], cfg = entry[1];
            state[name] = { models: self._getTierModels(cfg), strategy: cfg.strategy || 'balanced' };
        });
        return state;
    };

    TierBuilder.prototype._getTierModels = function(tierConfig) {
        if (!tierConfig) return [];
        if (Array.isArray(tierConfig.models) && tierConfig.models.length > 0) {
            return tierConfig.models.slice();
        }
        var models = [];
        if (tierConfig.targetModel) models.push(tierConfig.targetModel);
        if (Array.isArray(tierConfig.fallbackModels)) {
            models = models.concat(tierConfig.fallbackModels);
        } else if (tierConfig.failoverModel) {
            models.push(tierConfig.failoverModel);
        }
        return models.filter(Boolean);
    };

    TierBuilder.prototype._buildModelCard = function(modelId, modelsData, options) {
        options = options || {};
        var position = options.position !== undefined ? options.position : null;
        var showRemove = options.showRemove || false;
        var modelData = modelsData && modelsData[modelId];
        var displayName = modelData?.displayName || modelId;
        var self = this;

        var card = document.createElement('div');
        card.className = 'model-card';
        card.setAttribute('data-model-id', modelId);
        card.setAttribute('tabindex', '0');

        var top = document.createElement('div');
        top.className = 'model-card-top';
        var nameEl = document.createElement('span');
        nameEl.className = 'model-card-name';
        nameEl.textContent = displayName;
        nameEl.title = modelId;
        top.appendChild(nameEl);

        if (position !== null) {
            var posEl = document.createElement('span');
            posEl.className = 'model-card-position';
            posEl.textContent = '#' + (position + 1);
            top.appendChild(posEl);
        }
        card.appendChild(top);

        // Metadata row: tier badge, concurrency, pricing, vision
        var metaDiv = document.createElement('div');
        metaDiv.className = 'model-card-meta';

        if (modelData && modelData.tier) {
            var tierSpan = document.createElement('span');
            var tierNorm = String(modelData.tier).toLowerCase();
            tierSpan.className = 'model-card-tier tier-' + tierNorm;
            tierSpan.textContent = tierNorm.charAt(0).toUpperCase() + tierNorm.slice(1);
            metaDiv.appendChild(tierSpan);
        }

        if (modelData && modelData.maxConcurrency) {
            var slotsSpan = document.createElement('span');
            slotsSpan.className = 'model-card-slots';
            slotsSpan.title = 'Max concurrent requests per key';
            slotsSpan.textContent = String(modelData.maxConcurrency);
            metaDiv.appendChild(slotsSpan);
        }

        if (modelData) {
            var priceSpan = document.createElement('span');
            priceSpan.className = 'model-card-price';
            var pr = modelData.pricing || {};
            var totalCost = (pr.input || 0) + (pr.output || 0);
            if (totalCost > 0) {
                priceSpan.textContent = '$' + totalCost.toFixed(2);
                priceSpan.title = 'Cost per 1M tokens (input $' + (pr.input || 0).toFixed(2) + ' + output $' + (pr.output || 0).toFixed(2) + ')';
            } else {
                priceSpan.textContent = 'Free';
                priceSpan.title = 'No token cost';
            }
            metaDiv.appendChild(priceSpan);
        }

        if (modelData && modelData.supportsVision) {
            var visionSpan = document.createElement('span');
            visionSpan.className = 'model-card-vision';
            visionSpan.title = 'Supports vision/image input';
            visionSpan.textContent = 'V';
            metaDiv.appendChild(visionSpan);
        }

        card.appendChild(metaDiv);

        var badges = document.createElement('div');
        badges.className = 'model-card-badges';
        card.appendChild(badges);

        var bar = document.createElement('div');
        bar.className = 'model-card-bar';
        var barFill = document.createElement('div');
        barFill.className = 'model-card-bar-fill bar-low';
        barFill.style.width = '0%';
        bar.appendChild(barFill);
        // Add placeholder for outer text (when bar is too small for inline text)
        var barOuter = document.createElement('span');
        barOuter.className = 'model-card-bar-outer';
        barOuter.style.display = 'none';
        bar.appendChild(barOuter);
        card.appendChild(bar);

        if (showRemove) {
            var removeBtn = document.createElement('button');
            removeBtn.className = 'model-card-remove';
            removeBtn.textContent = '\u00d7';
            removeBtn.title = 'Remove from tier';
            removeBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                card.remove();
                self._onDragEnd();
            });
            card.appendChild(removeBtn);
        }

        return card;
    };

    TierBuilder.prototype._renderBank = function(availableModels, modelsData) {
        if (!this.bankList) return;
        this.bankList.innerHTML = '';
        if (!availableModels || availableModels.length === 0) {
            this.bankList.innerHTML = '<div class="tier-builder-empty">No models available</div>';
            if (this.bankCountEl) this.bankCountEl.textContent = '0';
            return;
        }
        var self = this;
        availableModels.forEach(function(modelId) {
            var card = self._buildModelCard(modelId, modelsData, { showRemove: false });
            self.bankList.appendChild(card);
        });
        if (this.bankCountEl) this.bankCountEl.textContent = String(availableModels.length);
    };

    TierBuilder.prototype._renderLane = function(laneEl, tierName, models, modelsData) {
        if (!laneEl) return;
        laneEl.innerHTML = '';
        if (models.length === 0) {
            laneEl.innerHTML = renderEmptyState('Drop models here', { icon: '\u2193' });
            return;
        }
        var self = this;
        models.forEach(function(modelId, i) {
            var card = self._buildModelCard(modelId, modelsData, { position: i, inTier: true, showRemove: true });
            laneEl.appendChild(card);
        });
    };

    TierBuilder.prototype._initSortable = function() {
        if (!FEATURES.sortable) {
            console.warn('SortableJS not available - drag-and-drop disabled');
            var builder = document.querySelector('.tier-builder-content');
            if (builder) {
                var msg = document.createElement('div');
                msg.className = 'sortable-unavailable';
                msg.textContent = 'Drag-and-drop unavailable - SortableJS not loaded';
                msg.style.cssText = 'padding: 12px; background: #fff3cd; color: #856404; border-radius: 4px; margin: 8px 0; text-align: center;';
                builder.insertBefore(msg, builder.firstChild);
            }
            return;
        }

        var self = this;
        if (this.bankList) {
            this.sortables.bank = Sortable.create(this.bankList, {
                group: { name: 'models', pull: 'clone', put: false },
                sort: false, animation: 150, swapThreshold: 0.65, invertSwap: true,
                fallbackOnBody: true, forceFallback: true, scrollSensitivity: 60,
                ghostClass: 'sortable-ghost', chosenClass: 'sortable-chosen', dragClass: 'sortable-drag',
                filter: '.tier-builder-empty',
                onClone: function(evt) {
                    var clone = evt.clone;
                    if (!clone.querySelector('.model-card-remove')) {
                        var removeBtn = document.createElement('button');
                        removeBtn.className = 'model-card-remove';
                        removeBtn.textContent = '\u00d7';
                        removeBtn.title = 'Remove from tier';
                        removeBtn.addEventListener('click', function(e) {
                            e.stopPropagation();
                            clone.remove();
                            self._onDragEnd();
                        });
                        clone.appendChild(removeBtn);
                    }
                }
            });
        }

        Object.entries(this.lanes).forEach(function(entry) {
            var tierName = entry[0], laneEl = entry[1];
            if (!laneEl) return;
            self.sortables[tierName] = Sortable.create(laneEl, {
                group: { name: 'models', pull: true, put: true },
                sort: true, animation: 150, swapThreshold: 0.65, invertSwap: true,
                fallbackOnBody: true, forceFallback: true, scrollSensitivity: 60,
                ghostClass: 'sortable-ghost', chosenClass: 'sortable-chosen', dragClass: 'sortable-drag',
                filter: '.tier-lane-empty',
                onAdd: function(evt) {
                    var empty = laneEl.querySelector('.tier-lane-empty');
                    if (empty) empty.remove();
                    var card = evt.item;
                    if (!card.querySelector('.model-card-remove')) {
                        var removeBtn = document.createElement('button');
                        removeBtn.className = 'model-card-remove';
                        removeBtn.textContent = '\u00d7';
                        removeBtn.title = 'Remove from tier';
                        removeBtn.addEventListener('click', function(e) {
                            e.stopPropagation();
                            card.remove();
                            self._onDragEnd();
                        });
                        card.appendChild(removeBtn);
                    }
                    self._onDragEnd();
                },
                onRemove: function() {
                    var modelCards = laneEl.querySelectorAll('.model-card');
                    if (modelCards.length === 0) {
                        laneEl.innerHTML = renderEmptyState('Drop models here', { icon: '\u2193' });
                    }
                    self._onDragEnd();
                },
                onUpdate: function() { self._onDragEnd(); }
            });
        });
    };

    TierBuilder.prototype._onDragEnd = function() {
        this._updatePositions();
        this._detectSharedModels();
        this._computePendingChanges();
    };

    TierBuilder.prototype._updatePositions = function() {
        Object.values(this.lanes).forEach(function(laneEl) {
            if (!laneEl) return;
            var cards = laneEl.querySelectorAll('.model-card');
            cards.forEach(function(card, i) {
                var posEl = card.querySelector('.model-card-position');
                if (!posEl) {
                    posEl = document.createElement('span');
                    posEl.className = 'model-card-position';
                    var top = card.querySelector('.model-card-top');
                    if (top) top.appendChild(posEl);
                }
                posEl.textContent = '#' + (i + 1);
            });
        });
    };

    TierBuilder.prototype._detectSharedModels = function() {
        var modelCounts = {};
        Object.values(this.lanes).forEach(function(laneEl) {
            if (!laneEl) return;
            laneEl.querySelectorAll('.model-card').forEach(function(card) {
                var modelId = card.getAttribute('data-model-id');
                if (modelId) modelCounts[modelId] = (modelCounts[modelId] || 0) + 1;
            });
        });

        Object.values(this.lanes).forEach(function(laneEl) {
            if (!laneEl) return;
            laneEl.querySelectorAll('.model-card').forEach(function(card) {
                var modelId = card.getAttribute('data-model-id');
                var isShared = modelId && modelCounts[modelId] > 1;
                var badges = card.querySelector('.model-card-badges');
                if (!badges) return;
                var sharedBadge = badges.querySelector('.model-card-shared');
                if (isShared && !sharedBadge) {
                    sharedBadge = document.createElement('span');
                    sharedBadge.className = 'model-card-shared';
                    sharedBadge.textContent = 'Shared';
                    badges.appendChild(sharedBadge);
                } else if (!isShared && sharedBadge) {
                    sharedBadge.remove();
                }
            });
        });
    };

    TierBuilder.prototype._computePendingChanges = function() {
        if (!this.serverState) { this._updatePending(0); return; }
        var count = 0;
        var currentState = this._getCurrentState();
        ['heavy', 'medium', 'light'].forEach(function(tierName) {
            var server = this.serverState[tierName] || { models: [], strategy: 'balanced' };
            var current = currentState[tierName] || { models: [], strategy: 'balanced' };
            if (server.strategy !== current.strategy) count++;
            if (server.models.length !== current.models.length) { count++; }
            else { for (var i = 0; i < server.models.length; i++) { if (server.models[i] !== current.models[i]) { count++; break; } } }
        }.bind(this));
        this._updatePending(count);
    };

    TierBuilder.prototype._getCurrentState = function() {
        var state = {};
        var self = this;
        Object.entries(this.lanes).forEach(function(entry) {
            var tierName = entry[0], laneEl = entry[1];
            var models = [];
            if (laneEl) {
                laneEl.querySelectorAll('.model-card').forEach(function(card) {
                    var modelId = card.getAttribute('data-model-id');
                    if (modelId) models.push(modelId);
                });
            }
            var stratSel = self.strategySelects[tierName];
            state[tierName] = { models: models, strategy: stratSel ? stratSel.value : 'balanced' };
        });
        return state;
    };

    TierBuilder.prototype._updatePending = function(count) {
        if (this.pendingBadge) this.pendingBadge.style.display = count > 0 ? 'inline-block' : 'none';
        if (this.pendingCount) this.pendingCount.textContent = String(count);
        if (this.saveBtn) this.saveBtn.disabled = count === 0;
        if (this.resetBtn) this.resetBtn.disabled = count === 0;
    };

    TierBuilder.prototype.save = function() {
        var self = this;
        if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer);
        this._saveDebounceTimer = setTimeout(function() { self._doSave(); }, 500);
    };

    TierBuilder.prototype._doSave = async function() {
        var currentState = this._getCurrentState();
        var payload = { tiers: {} };
        Object.entries(currentState).forEach(function(entry) {
            payload.tiers[entry[0]] = { models: entry[1].models, strategy: entry[1].strategy };
        });

        var saveAction = async function() {
            var res = await fetch('/model-routing', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                var result = await res.json().catch(function() { return {}; });
                if (result.persisted) {
                    showToast('Tier configuration saved and persisted', 'success');
                } else {
                    showToast('Tier configuration updated (runtime only)', 'warning');
                }
                await fetchModelRouting();
                // Verify save round-trip (roadmap 2.4)
                var submitted = JSON.stringify(payload.tiers || {});
                var returned = JSON.stringify((modelRoutingData && modelRoutingData.config && modelRoutingData.config.tiers) || {});
                if (submitted !== returned) {
                    if (typeof window.showToast === 'function') {
                        window.showToast('Warning: saved config differs from submitted — check for server-side normalization', 'warning');
                    }
                }
            } else {
                var err = await res.json().catch(function() { return {}; });
                var errMessage = err.message || err.error || res.statusText || 'Unknown error';
                showToast('Save failed: ' + errMessage, 'error');
                // On 409 (validation error), keep local state so user can fix the issue.
                // Only re-fetch server state on non-recoverable errors (500, 503, etc.)
                if (res.status !== 409) {
                    await fetchModelRouting();
                }
            }
        };

        if (this.saveBtn) {
            await withLoading(this.saveBtn, saveAction, { busyText: 'Saving...' });
        } else {
            await saveAction();
        }
    };

    TierBuilder.prototype.reset = function() {
        if (modelRoutingData) {
            var availableModels = window.DashboardFilters?.getAvailableModels ? window.DashboardFilters.getAvailableModels() : [];
            this.render(modelRoutingData, STATE.modelsData, availableModels);
            showToast('Tier configuration reset to server state', 'info');
        }
    };

    TierBuilder.prototype.updatePoolStatus = function(pools) {
        if (!pools) return;
        var self = this;
        Object.entries(pools).forEach(function(entry) {
            var tierName = entry[0], models = entry[1];
            if (!Array.isArray(models)) return;
            models.forEach(function(m) {
                self._updateModelCards(m.model, m.inFlight, m.maxConcurrency, m.cooldownMs);
            });
        });
    };

    TierBuilder.prototype._updateModelCards = function(modelId, inFlight, maxConcurrency, cooldownMs) {
        var allCards = this.container
            ? this.container.querySelectorAll('.model-card[data-model-id="' + CSS.escape(modelId) + '"]')
            : [];
        var isAtCapacity = maxConcurrency > 0 && inFlight >= maxConcurrency;
        var isGLM5 = modelId.includes('glm-5');

        allCards.forEach(function(card) {
            var barFill = card.querySelector('.model-card-bar-fill');
            var barOuter = card.querySelector('.model-card-bar-outer');
            var bar = card.querySelector('.model-card-bar');

            if (barFill && maxConcurrency > 0) {
                var pct = Math.round((inFlight / maxConcurrency) * 100);
                barFill.style.width = pct + '%';
                barFill.className = 'model-card-bar-fill ' + (
                    cooldownMs > 0 ? 'bar-cooled' : pct >= 80 ? 'bar-high' : pct >= 50 ? 'bar-medium' : 'bar-low'
                );

                // Show value inside bar if wide enough, otherwise outside
                var showInline = pct >= 25;
                var valueText = inFlight + '/' + maxConcurrency;

                if (showInline) {
                    barFill.innerHTML = '<span class="model-card-bar-text">' + valueText + '</span>';
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

            var busyBadge = card.querySelector('.model-busy-indicator');
            if (isAtCapacity && isGLM5) {
                if (!busyBadge) {
                    busyBadge = document.createElement('div');
                    busyBadge.className = 'model-busy-indicator';
                    busyBadge.title = 'Model at capacity - requests will fall back to other Heavy tier models';
                    busyBadge.innerHTML = '<span class="busy-icon">\u26A0</span><span class="busy-text">Busy (' + inFlight + '/' + maxConcurrency + ')</span>';
                    card.insertBefore(busyBadge, card.firstChild);
                } else {
                    var busyText = busyBadge.querySelector('.busy-text');
                    if (busyText) busyText.textContent = 'Busy (' + inFlight + '/' + maxConcurrency + ')';
                }
            } else if (busyBadge) {
                busyBadge.remove();
            }

            var badges = card.querySelector('.model-card-badges');
            if (badges) {
                var cooldownBadge = badges.querySelector('.model-card-cooldown');
                if (cooldownMs > 0) {
                    if (!cooldownBadge) {
                        cooldownBadge = document.createElement('span');
                        cooldownBadge.className = 'model-card-cooldown';
                        badges.appendChild(cooldownBadge);
                    }
                    cooldownBadge.textContent = Math.ceil(cooldownMs / 1000) + 's';
                } else if (cooldownBadge) {
                    cooldownBadge.remove();
                }
            }
        });
    };

    TierBuilder.prototype.updateShadowBadges = function(routingConfig) {
        if (!this.container) return;
        var glm5Config = routingConfig?.glm5 || {};
        var isShadowMode = glm5Config.enabled !== false && (glm5Config.preferencePercent ?? 0) === 0;

        this.container.querySelectorAll('.model-card').forEach(function(card) {
            var modelId = card.getAttribute('data-model-id');
            var isGLM5 = modelId && modelId.includes('glm-5');
            var badges = card.querySelector('.model-card-badges');
            if (!badges) return;
            var shadowBadge = badges.querySelector('.model-card-shadow');
            if (isShadowMode && isGLM5) {
                if (!shadowBadge) {
                    shadowBadge = document.createElement('span');
                    shadowBadge.className = 'model-card-shadow';
                    shadowBadge.textContent = 'Shadow';
                    shadowBadge.title = 'Shadow mode: GLM-5 preference is 0% (tracking eligible requests only)';
                    badges.appendChild(shadowBadge);
                }
            } else if (shadowBadge) {
                shadowBadge.remove();
            }
        });
    };

    TierBuilder.prototype._ensureTooltip = function() {
        if (this._tooltip) return this._tooltip;
        var tip = document.createElement('div');
        tip.id = 'modelCardTooltip';
        tip.className = 'model-card-tooltip';
        tip.setAttribute('role', 'tooltip');
        tip.style.display = 'none';
        this.container.appendChild(tip);
        this._tooltip = tip;
        return tip;
    };

    TierBuilder.prototype._showTooltip = function(card, modelId) {
        var data = this._modelsData && this._modelsData[modelId];
        if (!data) return;
        var tip = this._ensureTooltip();
        tip.textContent = '';

        var pr = data.pricing || {};

        function addRow(parent, label, value) {
            var row = document.createElement('div');
            row.className = 'tooltip-row';
            var labelEl = document.createElement('span');
            labelEl.className = 'tooltip-label';
            labelEl.textContent = label;
            var valEl = document.createElement('span');
            valEl.className = 'tooltip-value';
            valEl.textContent = value;
            row.appendChild(labelEl);
            row.appendChild(valEl);
            parent.appendChild(row);
        }

        var header = document.createElement('div');
        header.className = 'tooltip-header';
        var nameStrong = document.createElement('strong');
        nameStrong.textContent = data.displayName || modelId;
        header.appendChild(nameStrong);
        var idSpan = document.createElement('span');
        idSpan.className = 'tooltip-id';
        idSpan.textContent = ' (' + modelId + ')';
        header.appendChild(idSpan);
        tip.appendChild(header);

        if (data.description) {
            var desc = document.createElement('div');
            desc.className = 'tooltip-desc';
            desc.textContent = data.description;
            tip.appendChild(desc);
        }

        tip.appendChild(document.createElement('hr'));

        addRow(tip, 'Tier', data.tier || 'Unknown');
        addRow(tip, 'Type', data.type || 'chat');
        addRow(tip, 'Context', data.contextLength ? (data.contextLength / 1000) + 'K' : '?');
        addRow(tip, 'Concurrency', (data.maxConcurrency || '?') + ' per key');
        addRow(tip, 'Vision', data.supportsVision ? 'Yes' : 'No');
        addRow(tip, 'Streaming', data.supportsStreaming !== false ? 'Yes' : 'No');

        tip.appendChild(document.createElement('hr'));
        var totalCost = (pr.input || 0) + (pr.output || 0);
        if (totalCost > 0) {
            var priceHeader = document.createElement('strong');
            priceHeader.textContent = 'Pricing (per 1M tokens)';
            tip.appendChild(priceHeader);
            addRow(tip, 'Input', '$' + (pr.input || 0).toFixed(2));
            addRow(tip, 'Output', '$' + (pr.output || 0).toFixed(2));
            if (pr.cachedInput > 0) addRow(tip, 'Cached', '$' + pr.cachedInput.toFixed(2));
        } else {
            var freeLabel = document.createElement('strong');
            freeLabel.textContent = 'Free tier \u2014 no token cost';
            tip.appendChild(freeLabel);
        }

        var rect = card.getBoundingClientRect();
        var containerRect = this.container.getBoundingClientRect();
        tip.style.display = 'block';

        var tipW = tip.offsetWidth;
        var tipH = tip.offsetHeight;
        var left = rect.left - containerRect.left + rect.width / 2 - tipW / 2;
        var top = rect.top - containerRect.top - tipH - 8;

        if (rect.top - tipH - 8 < 0) {
            top = rect.bottom - containerRect.top + 8;
        }
        if (left < 0) left = 4;
        if (left + tipW > containerRect.width) left = containerRect.width - tipW - 4;

        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
    };

    TierBuilder.prototype._hideTooltip = function() {
        if (this._tooltip) this._tooltip.style.display = 'none';
    };

    TierBuilder.prototype.sortBank = function(sortBy) {
        if (!this._bankModels || !this._modelsData) return;
        this._bankSort = sortBy;
        var modelsData = this._modelsData;
        var TIER_ORDER = { HEAVY: 0, MEDIUM: 1, LIGHT: 2, FREE: 3 };

        function getPrice(d) {
            var p = d && d.pricing;
            return p ? (p.input || 0) + (p.output || 0) : 0;
        }

        var sorted = this._bankModels.slice().sort(function(a, b) {
            var da = modelsData[a] || {};
            var db = modelsData[b] || {};
            var result;
            switch (sortBy) {
                case 'tier':
                    var ta = TIER_ORDER[String(da.tier || '').toUpperCase()];
                    var tb = TIER_ORDER[String(db.tier || '').toUpperCase()];
                    result = (ta !== undefined ? ta : 99) - (tb !== undefined ? tb : 99);
                    break;
                case 'price-asc':
                    result = getPrice(da) - getPrice(db);
                    break;
                case 'price-desc':
                    result = getPrice(db) - getPrice(da);
                    break;
                case 'concurrency':
                    result = (db.maxConcurrency || 0) - (da.maxConcurrency || 0);
                    break;
                default:
                    result = 0;
            }
            if (result === 0) result = (da.displayName || a).localeCompare(db.displayName || b);
            if (result === 0) result = a.localeCompare(b);
            return result;
        });

        this._renderBank(sorted, modelsData);
    };

    TierBuilder.prototype._destroySortables = function() {
        Object.values(this.sortables).forEach(function(sortable) {
            if (sortable && typeof sortable.destroy === 'function') sortable.destroy();
        });
        this.sortables = {};
    };

    TierBuilder.prototype.destroy = function() {
        this._destroyed = true;
        this._destroySortables();
        if (this._saveDebounceTimer) { clearTimeout(this._saveDebounceTimer); this._saveDebounceTimer = null; }
        if (this.saveBtn) this.saveBtn.removeEventListener('click', this._onSave);
        if (this.resetBtn) this.resetBtn.removeEventListener('click', this._onReset);
        var self = this;
        Object.values(this.strategySelects).forEach(function(sel) {
            if (sel) sel.removeEventListener('change', self._onStrategyChange);
        });
        // Clean up tooltip delegation listeners
        if (this.container) {
            this.container.removeEventListener('mouseenter', this._onMouseEnter, true);
            this.container.removeEventListener('mouseleave', this._onMouseLeave, true);
            this.container.removeEventListener('focusin', this._onFocusIn);
            this.container.removeEventListener('focusout', this._onFocusOut);
        }
        // Remove tooltip DOM element
        if (this._tooltip && this._tooltip.parentNode) {
            this._tooltip.parentNode.removeChild(this._tooltip);
            this._tooltip = null;
        }
        window._tierBuilder = null;
    };

    // ========== MODEL ROUTING FUNCTIONS ==========
    // (Placeholder references - the actual fetch/render functions remain in the original dashboard.js
    //  and are exposed via window for backward compatibility)

    async function fetchModelRouting() {
        var data = await DS.fetchJSON('/model-routing');
        if (data) {
            modelRoutingData = data;
            window.modelRoutingData = data;
            STATE.routingData = data;
            renderModelRouting(data);
        }
    }

    function renderModelRouting(data) {
        // Update routing enabled status
        var statusEl = document.getElementById('routingStatus');
        if (statusEl) {
            statusEl.textContent = data.enabled ? 'Enabled' : 'Disabled';
            statusEl.className = 'routing-status ' + (data.enabled ? 'enabled' : 'disabled');
        }

        // Toggle between disabled CTA and full tier builder
        var ctaEl = document.getElementById('routingDisabledCTA');
        var enabledContentEl = document.getElementById('routingEnabledContent');
        var liveFlowEl = document.getElementById('liveFlowContainer');
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
        var toggleBtn = document.getElementById('routingToggleBtn');
        if (toggleBtn) {
            toggleBtn.textContent = data.enabled ? 'Disable' : 'Enable';
            toggleBtn.className = 'btn btn-small routing-toggle-btn' + (data.enabled ? ' btn-secondary' : ' btn-primary');
        }

        // Update flow diagram
        if (window.DashboardLiveFlow?.updateFlowDiagram) {
            window.DashboardLiveFlow.updateFlowDiagram(data.enabled);
        }

        // Render fallback chains
        if (window.DashboardLiveFlow?.renderFallbackChains) {
            window.DashboardLiveFlow.renderFallbackChains(data);
        }

        // Render pool status
        if (window.DashboardLiveFlow?.renderPoolStatus) {
            window.DashboardLiveFlow.renderPoolStatus(data);
        }

        // Render cooldowns and overrides
        if (window.DashboardLiveFlow?.renderRoutingCooldowns) {
            window.DashboardLiveFlow.renderRoutingCooldowns();
        }
        if (window.DashboardLiveFlow?.renderRoutingOverrides) {
            window.DashboardLiveFlow.renderRoutingOverrides();
        }

        // Render routing rules
        renderRoutingRules(data);

        // Render per-model usage
        renderPerModelUsage(data);

        // Update observability charts
        updateRoutingDistributionCharts();

        // Initialize or update TierBuilder
        if (!window._tierBuilder) {
            window._tierBuilder = new TierBuilder();
        }
        var availableModels = window.DashboardFilters?.getAvailableModels ? window.DashboardFilters.getAvailableModels() : [];
        window._tierBuilder.render(data, STATE.modelsData, availableModels);

        // Start pool polling if section is visible
        if (window.DashboardLiveFlow?.startPoolPolling) {
            window.DashboardLiveFlow.startPoolPolling();
        }
    }

    function renderRoutingRules(data) {
        var body = document.getElementById('routingRulesBody');
        if (!body) return;
        var rules = data?.config?.rules || [];
        if (rules.length === 0) {
            body.innerHTML = '<tr><td colspan="4" style="color: var(--text-secondary);">No custom rules configured</td></tr>';
            return;
        }
        body.innerHTML = rules.map(function(rule, i) {
            return '<tr><td>' + (i + 1) + '</td>' +
                '<td>' + escapeHtml(rule.pattern || '*') + '</td>' +
                '<td>' + escapeHtml(rule.targetModel || rule.model || '-') + '</td>' +
                '<td><button class="btn btn-danger btn-small" data-action="remove-routing-rule" data-rule-index="' + i + '">Remove</button></td></tr>';
        }).join('');
    }

    function renderPerModelUsage(data) {
        var body = document.getElementById('perModelUsageBody');
        if (!body) return;
        var stats = data?.stats?.byModel || {};
        var entries = Object.entries(stats);
        if (entries.length === 0) {
            body.innerHTML = '<tr><td colspan="4" style="color: var(--text-secondary);">No model usage data</td></tr>';
            return;
        }
        var total = entries.reduce(function(sum, entry) { return sum + (entry[1] || 0); }, 0);
        body.innerHTML = entries.sort(function(a, b) { return (b[1] || 0) - (a[1] || 0); }).map(function(entry) {
            var model = entry[0], count = entry[1] || 0;
            var pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
            return '<tr><td>' + escapeHtml(model) + '</td>' +
                '<td>' + count + '</td>' +
                '<td>' + pct + '%</td>' +
                '<td><div class="usage-bar"><div class="usage-bar-fill" style="width: ' + pct + '%;"></div></div></td></tr>';
        }).join('');
    }

    function updateRoutingDistributionCharts() {
        if (!modelRoutingData || typeof Chart === 'undefined') return;
        var stats = modelRoutingData.stats || {};

        // Tier doughnut
        var tierEl = document.getElementById('routingTierChart');
        var tierChart = tierEl && Chart.getChart(tierEl);
        if (tierChart) {
            var byTier = stats.byTier || {};
            tierChart.data.datasets[0].data = [
                byTier.light || 0,
                byTier.medium || 0,
                byTier.heavy || 0
            ];
            tierChart.update('none');
        }

        // Source doughnut
        var srcEl = document.getElementById('routingSourceChart');
        var sourceChart = srcEl && Chart.getChart(srcEl);
        if (sourceChart) {
            var src = stats.bySource || {};
            sourceChart.data.datasets[0].data = [
                (src.override || 0) + (src['saved-override'] || 0),
                src.rule || 0,
                src.classifier || 0,
                src['default'] || 0,
                src.failover || 0
            ];
            sourceChart.update('none');
        }
    }

    // ========== ROUTING OBSERVABILITY ==========
    var ROUTING_TIME_MINUTES = { '5m': 5, '1h': 60, '24h': 1440 };
    var routingObsTimeRange = '5m';

    function updateRoutingObsKPIs(history) {
        var statusEl = document.getElementById('routingObsStatus');
        var kpisEl = document.querySelector('.routing-obs-kpis');
        var hasData = history?.points?.length > 0;
        var routingDisabled = modelRoutingData !== null && !modelRoutingData.enabled;

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

        if (kpisEl) {
            kpisEl.style.opacity = hasData ? '1' : routingDisabled ? '0.4' : '0.6';
        }

        if (!hasData) return;

        var pts = history.points;
        var setVal = function(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };

        var totalDeltaSum = 0, burstDeltaSum = 0, failoverDeltaSum = 0;
        for (var i = 0; i < pts.length; i++) {
            totalDeltaSum += pts[i].routing?.totalDelta || 0;
            burstDeltaSum += pts[i].routing?.burstDelta || 0;
            failoverDeltaSum += pts[i].routing?.failoverDelta || 0;
        }

        setVal('routingBurstShare', totalDeltaSum > 0 ? (burstDeltaSum / totalDeltaSum * 100).toFixed(1) + '%' : '0.0%');
        setVal('routingFailoverShare', totalDeltaSum > 0 ? (failoverDeltaSum / totalDeltaSum * 100).toFixed(1) + '%' : '0.0%');

        var windowMinutes = ROUTING_TIME_MINUTES[routingObsTimeRange] || 5;
        var rateLimitedSum = pts.reduce(function(s, p) { return s + (p.rateLimitedDelta || 0); }, 0);
        setVal('routing429PerMin', windowMinutes > 0 ? (rateLimitedSum / windowMinutes).toFixed(1) : '0');
        setVal('routingDecisionsInWindow', String(totalDeltaSum));
    }

    if (window.__DASHBOARD_DEBUG__) window.__DASHBOARD_DEBUG__.updateRoutingObsKPIs = updateRoutingObsKPIs;

    function updatePoolCooldownKPI(statsData) {
        var pool = statsData?.poolRateLimitStatus;
        var el = document.getElementById('routingPoolCooldown');
        if (!el) return;
        if (!modelRoutingData?.enabled) { el.textContent = '\u2014'; return; }
        if (pool && pool.inCooldown) {
            el.textContent = Math.ceil(pool.remainingMs / 1000) + 's';
        } else {
            el.textContent = 'Idle';
        }
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

    // ========== ROUTING ACTION FUNCTIONS ==========

    function addRoutingOverride() {
        var keyEl = document.getElementById('routingOverrideKey');
        var modelEl = document.getElementById('routingOverrideModel');
        if (!keyEl || !modelEl) return;
        var key = keyEl.value.trim();
        var model = modelEl.value.trim();
        if (!key || !model) { showToast('Key and model are required', 'error'); return; }
        fetch('/model-routing/overrides', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: key, model: model })
        }).then(function(res) {
            if (res.ok) {
                return res.json().then(function(result) {
                    keyEl.value = '';
                    modelEl.value = '';
                    if (result.warning === 'runtime_only_change') {
                        showToast('Override added (runtime only)', 'warning');
                    } else if (result.persisted === true) {
                        showToast('Override added and persisted', 'success');
                    } else {
                        showToast('Override added', 'success');
                    }
                    fetchModelRouting();
                });
            } else {
                return res.json().then(function(data) { showToast(data.error || 'Failed to add override', 'error'); });
            }
        }).catch(function() { showToast('Failed to add override', 'error'); });
    }

    function removeRoutingOverride(key) {
        fetch('/model-routing/overrides', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: key })
        }).then(function(res) {
            if (res.ok) {
                return res.json().then(function(result) {
                    if (result.warning === 'runtime_only_change') showToast('Override removed (runtime only)', 'warning');
                    else if (result.persisted === true) showToast('Override removed and persisted', 'success');
                    else showToast('Override removed', 'success');
                    fetchModelRouting();
                });
            } else {
                showToast('Failed to remove override', 'error');
            }
        }).catch(function() { showToast('Failed to remove override', 'error'); });
    }

    function saveTierConfig(tierName) {
        if (window._tierBuilder) {
            window._tierBuilder.save();
            return;
        }
        var btn = document.querySelector('[data-action="save-tier"][data-tier="' + tierName + '"]');
        var targetModelEl = document.querySelector('[data-tier="' + tierName + '"][data-field="targetModel"]');
        var row = targetModelEl ? targetModelEl.closest('tr') : null;
        if (!row) return;
        var targetModel = row.querySelector('[data-field="targetModel"]').value.trim();
        var fallbackStr = row.querySelector('[data-field="fallbackModels"]').value.trim();
        var strategy = row.querySelector('[data-field="strategy"]').value;
        var policy = row.querySelector('[data-field="clientModelPolicy"]').value;
        var fallbackModels = fallbackStr ? fallbackStr.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
        var tiers = {};
        tiers[tierName] = { targetModel: targetModel, fallbackModels: fallbackModels, strategy: strategy, clientModelPolicy: policy };
        var saveAction = function() {
            return fetch('/model-routing', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ tiers: tiers })
            }).then(function(res) {
                if (res.ok) {
                    return res.json().then(function(result) {
                        if (result.persisted) showToast('Tier "' + tierName + '" updated and persisted', 'success');
                        else showToast('Tier "' + tierName + '" updated (runtime only)', 'warning');
                        fetchModelRouting();
                    });
                } else {
                    return res.json().then(function(err) { showToast('Failed: ' + (err.error || res.statusText), 'error'); });
                }
            });
        };
        if (btn) { withLoading(btn, saveAction, { busyText: 'Saving...' }); }
        else { saveAction(); }
    }

    function addRoutingRule() {
        var modelEl = document.getElementById('ruleModelGlob');
        var model = modelEl ? modelEl.value.trim() : null;
        if (model === '') model = null;
        var maxTokensGte = parseInt((document.getElementById('ruleMaxTokens') || {}).value) || undefined;
        var messageCountGte = parseInt((document.getElementById('ruleMessages') || {}).value) || undefined;
        var hasToolsEl = document.getElementById('ruleHasTools');
        var hasTools = hasToolsEl ? hasToolsEl.checked : false;
        var hasVisionEl = document.getElementById('ruleHasVision');
        var hasVision = hasVisionEl ? hasVisionEl.checked : false;
        var tierEl = document.getElementById('ruleTier');
        var tier = tierEl ? tierEl.value : 'light';
        var match = {};
        if (model) match.model = model;
        if (maxTokensGte) match.maxTokensGte = maxTokensGte;
        if (messageCountGte) match.messageCountGte = messageCountGte;
        if (hasTools) match.hasTools = true;
        if (hasVision) match.hasVision = true;
        var currentRules = (modelRoutingData && modelRoutingData.config && modelRoutingData.config.rules) ? modelRoutingData.config.rules : [];
        var newRules = currentRules.concat([{ match: match, tier: tier }]);
        fetch('/model-routing', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rules: newRules })
        }).then(function(res) {
            if (res.ok) {
                showToast('Rule added', 'success');
                if (document.getElementById('ruleModelGlob')) document.getElementById('ruleModelGlob').value = '';
                if (document.getElementById('ruleMaxTokens')) document.getElementById('ruleMaxTokens').value = '';
                if (document.getElementById('ruleMessages')) document.getElementById('ruleMessages').value = '';
                if (document.getElementById('ruleHasTools')) document.getElementById('ruleHasTools').checked = false;
                if (document.getElementById('ruleHasVision')) document.getElementById('ruleHasVision').checked = false;
                fetchModelRouting();
            } else { showToast('Failed to add rule', 'error'); }
        }).catch(function() { showToast('Failed to add rule', 'error'); });
    }

    function removeRoutingRule(index) {
        var currentRules = (modelRoutingData && modelRoutingData.config && modelRoutingData.config.rules) ? modelRoutingData.config.rules : [];
        var newRules = currentRules.filter(function(_, i) { return i !== index; });
        fetch('/model-routing', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rules: newRules })
        }).then(function(res) {
            if (res.ok) { showToast('Rule removed', 'success'); fetchModelRouting(); }
            else { showToast('Failed to remove rule', 'error'); }
        }).catch(function() { showToast('Failed to remove rule', 'error'); });
    }

    function runRoutingTest() {
        var availableModels = (window.DashboardFilters && window.DashboardFilters.getAvailableModels) ? window.DashboardFilters.getAvailableModels() : [];
        var defaultModel = availableModels.length > 0 ? availableModels[0] : '';
        var modelEl = document.getElementById('routingTestModel');
        var model = modelEl ? modelEl.value : defaultModel;
        var maxTokensEl = document.getElementById('routingTestMaxTokens');
        var maxTokens = maxTokensEl ? maxTokensEl.value : '';
        var messagesEl = document.getElementById('routingTestMessages');
        var messages = messagesEl ? messagesEl.value : '1';
        var systemLengthEl = document.getElementById('routingTestSystemLength');
        var systemLength = systemLengthEl ? systemLengthEl.value : '0';
        var toolsEl = document.getElementById('routingTestTools');
        var tools = toolsEl ? toolsEl.checked : false;
        var visionEl = document.getElementById('routingTestVision');
        var vision = visionEl ? visionEl.checked : false;
        var url = '/model-routing/test?model=' + encodeURIComponent(model) +
            '&messages=' + encodeURIComponent(messages) +
            '&system_length=' + encodeURIComponent(systemLength);
        if (maxTokens) url += '&max_tokens=' + encodeURIComponent(maxTokens);
        if (tools) url += '&tools=true';
        if (vision) url += '&vision=true';
        fetch(url).then(function(res) { return res.json(); }).then(function(data) {
            var resultEl = document.getElementById('routingTestResult');
            if (resultEl) {
                resultEl.classList.add('visible');
                var tier = (data.classification && data.classification.tier) ? data.classification.tier : 'none';
                var reason = (data.classification && data.classification.reason) ? data.classification.reason : 'no match';
                var target = data.selectedModel || data.targetModel || 'passthrough';
                resultEl.innerHTML = '<strong>Tier:</strong> ' + escapeHtml(tier) + ' | <strong>Target:</strong> ' + escapeHtml(target) + '<br><strong>Reason:</strong> ' + escapeHtml(reason);
            }
        }).catch(function(err) { showToast('Test failed: ' + err.message, 'error'); });
    }

    function runExplain() {
        var modelEl = document.getElementById('routingTestModel');
        var model = modelEl ? modelEl.value : 'claude-sonnet-4-5-20250929';
        var maxTokensStr = (document.getElementById('routingTestMaxTokens') || {}).value || '';
        var messageCount = parseInt((document.getElementById('routingTestMessages') || {}).value) || 1;
        var systemLength = parseInt((document.getElementById('routingTestSystemLength') || {}).value) || 0;
        var hasToolsEl = document.getElementById('routingTestTools');
        var hasTools = hasToolsEl ? hasToolsEl.checked : false;
        var hasVisionEl = document.getElementById('routingTestVision');
        var hasVision = hasVisionEl ? hasVisionEl.checked : false;
        var body = { model: model, messageCount: messageCount, systemLength: systemLength, hasTools: hasTools, hasVision: hasVision };
        if (maxTokensStr) body.maxTokens = parseInt(maxTokensStr);
        var btn = document.getElementById('explainBtn');
        if (btn) btn.disabled = true;
        fetch('/model-routing/explain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function(res) { return res.json(); })
        .then(function(data) { renderExplainResult(data); })
        .catch(function(err) {
            var container = document.getElementById('explainResult');
            if (container) {
                container.style.display = 'block';
                container.innerHTML = '<div class="explain-result"><div class="explain-reason">Error: ' + escapeHtml(err.message) + '</div></div>';
            }
        }).then(function() { if (btn) btn.disabled = false; });
    }

    function renderExplainResult(data) {
        var container = document.getElementById('explainResult');
        if (!container) return;
        container.style.display = 'block';
        var html = '<div class="explain-result">';
        html += '<div class="explain-summary"><strong>Selected:</strong> ' + escapeHtml(data.selectedModel);
        if (data.tier) html += ' <span class="tier-badge tier-badge-' + escapeHtml(data.tier) + '">' + escapeHtml(data.tier) + '</span>';
        if (data.strategy) html += ' <span class="strategy-label">' + escapeHtml(data.strategy) + '</span>';
        html += '</div>';
        if (data.reason) html += '<div class="explain-reason">' + escapeHtml(data.reason) + '</div>';
        if (data.scoringTable && data.scoringTable.length > 0) {
            html += '<table class="explain-scoring-table">';
            html += '<thead><tr><th>Model</th><th>Pos</th><th>Score</th><th>Avail</th><th>Max</th><th>Cost</th><th>Hits</th><th></th></tr></thead>';
            html += '<tbody>';
            for (var i = 0; i < data.scoringTable.length; i++) {
                var row = data.scoringTable[i];
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
        if (data.cooldownReasons && data.cooldownReasons.length > 0) {
            html += '<div class="explain-cooldowns"><strong>Cooldowns:</strong><ul>';
            for (var j = 0; j < data.cooldownReasons.length; j++) {
                var cd = data.cooldownReasons[j];
                html += '<li>' + escapeHtml(cd.model) + ': ' + Math.ceil(cd.remainingMs / 1000) + 's remaining';
                if (cd.burstDampened) html += ' (burst dampened)';
                html += '</li>';
            }
            html += '</ul></div>';
        }
        if (data.matchedRule) {
            html += '<div class="explain-match"><strong>Matched Rule:</strong> <code>' + escapeHtml(JSON.stringify(data.matchedRule)) + '</code></div>';
        } else if (data.classifierResult) {
            html += '<div class="explain-match"><strong>Classifier:</strong> tier=' + escapeHtml(data.classifierResult.tier) + ', reason=' + escapeHtml(data.classifierResult.reason) + '</div>';
        }
        if (data.features) {
            html += '<details class="explain-features"><summary>Request Features</summary><pre>' + escapeHtml(JSON.stringify(data.features, null, 2)) + '</pre></details>';
        }
        if (data.migrationPreview) {
            html += '<details class="explain-migration"><summary>Migration Preview</summary><pre>' + escapeHtml(JSON.stringify(data.migrationPreview, null, 2)) + '</pre></details>';
        }
        html += '</div>';
        container.innerHTML = html;
    }

    function resetModelRouting() {
        fetch('/model-routing/reset', { method: 'POST' }).then(function(res) {
            if (res.ok) {
                return res.json().then(function(result) {
                    if (result.warning === 'runtime_only_change') showToast('Model routing reset (runtime only)', 'warning');
                    else if (result.persisted === true) showToast('Model routing reset and persisted', 'success');
                    else showToast('Model routing reset', 'success');
                    fetchModelRouting();
                });
            } else { showToast('Failed to reset model routing', 'error'); }
        }).catch(function(err) { showToast('Failed to reset: ' + err.message, 'error'); });
    }

    function copyRoutingJson() {
        if (!modelRoutingData) { showToast('No routing data available', 'warning'); return; }
        var json = JSON.stringify(modelRoutingData, null, 2);
        navigator.clipboard.writeText(json).then(function() {
            showToast('Routing JSON copied', 'success');
        }).catch(function() {
            var textarea = document.createElement('textarea');
            textarea.value = json;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            showToast('Routing JSON copied', 'success');
        });
    }

    function exportRoutingJson() {
        fetch('/model-routing/export').then(function(r) { return r.blob(); }).then(function(blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'model-routing-export-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('Routing export downloaded', 'success');
        }).catch(function(err) { showToast('Export failed: ' + err.message, 'error'); });
    }

    function renderModelUsage() {
        var body = document.getElementById('modelUsageBody');
        if (!body) return;
        var stats = (DS && DS.STATE && DS.STATE.statsData && DS.STATE.statsData.modelStats) ? DS.STATE.statsData.modelStats : {};
        var entries = [];
        var models = Object.keys(stats);
        for (var i = 0; i < models.length; i++) {
            var m = models[i];
            if (m.indexOf('glm-') === 0 || m.indexOf('cogview-') === 0 || m === 'glm-ocr' || m === 'glm-flash') {
                entries.push([m, stats[m]]);
            }
        }
        if (entries.length === 0) {
            body.innerHTML = DS.renderTableEmptyState(6, 'No data yet');
            return;
        }
        entries.sort(function(a, b) { return b[1].requests - a[1].requests; });
        body.innerHTML = entries.map(function(entry) {
            var model = entry[0], s = entry[1];
            var successRate = s.successRate != null ? s.successRate.toFixed(1) + '%' : '-';
            var avgLatency = s.avgLatencyMs != null ? Math.round(s.avgLatencyMs) + 'ms' : '-';
            var tokens = (s.inputTokens || 0).toLocaleString() + ' / ' + (s.outputTokens || 0).toLocaleString();
            return '<tr><td style="font-family: JetBrains Mono, monospace; font-size: 0.75rem;">' + escapeHtml(model) + '</td>' +
                '<td>' + s.requests + '</td><td>' + successRate + '</td><td>' + (s.rate429 || 0) + '</td><td>' + avgLatency + '</td>' +
                '<td style="font-size: 0.7rem;">' + tokens + '</td></tr>';
        }).join('');
    }

    // ========== EXPORT ==========
    window.DashboardTierBuilder = {
        TierBuilder: TierBuilder,
        withLoading: withLoading,
        fetchModelRouting: fetchModelRouting,
        renderModelRouting: renderModelRouting,
        updateRoutingObsKPIs: updateRoutingObsKPIs,
        updatePoolCooldownKPI: updatePoolCooldownKPI,
        startRoutingCooldownRefresh: startRoutingCooldownRefresh,
        stopRoutingCooldownRefresh: stopRoutingCooldownRefresh,
        getModelRoutingData: function() { return modelRoutingData; },
        ROUTING_TIME_MINUTES: ROUTING_TIME_MINUTES,
        addRoutingOverride: addRoutingOverride,
        removeRoutingOverride: removeRoutingOverride,
        saveTierConfig: saveTierConfig,
        addRoutingRule: addRoutingRule,
        removeRoutingRule: removeRoutingRule,
        runRoutingTest: runRoutingTest,
        runExplain: runExplain,
        renderExplainResult: renderExplainResult,
        resetModelRouting: resetModelRouting,
        copyRoutingJson: copyRoutingJson,
        exportRoutingJson: exportRoutingJson,
        renderModelUsage: renderModelUsage,
        sortBank: function(sortBy) { if (window._tierBuilder) window._tierBuilder.sortBank(sortBy); }
    };

    // Expose for debug and backward compat
    if (DS.debugEnabled) {
        window.withLoading = withLoading;
    }

})(window);
