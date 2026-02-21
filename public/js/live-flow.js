/**
 * live-flow.js — Live Flow Visualization (D3.js)
 * Phase 6: Split from dashboard.js
 *
 * Provides: window.DashboardLiveFlow
 * Contains: LiveFlowViz class, fallback chain visualization,
 * pool status visualization, routing cooldowns/overrides.
 */
(function(window) {
    'use strict';

    var DS = window.DashboardStore;
    var STATE = DS.STATE;
    var FEATURES = DS.FEATURES;
    var escapeHtml = DS.escapeHtml;
    var showToast = window.showToast;

    // ========== LIVE FLOW VISUALIZATION (D3.js) ==========
    function LiveFlowViz(canvasId) {
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

        this.MAX_PARTICLES = 25;
        this.overflowCount = 0;

        this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this._motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        var self = this;
        this._motionHandler = function(e) { self.reducedMotion = e.matches; };
        this._motionQuery.addEventListener('change', this._motionHandler);

        this._visHandler = function() { self._onVisibilityChange(); };
        document.addEventListener('visibilitychange', this._visHandler);

        this._sseHandler = function(e) { self._onPoolStatus(e); };
        this._sseAttached = false;

        this._usePolling = false;
        this._pollTimer = null;

        this._initSvg();
    }

    LiveFlowViz.prototype._initSvg = function() {
        if (!this.canvas || !FEATURES.d3) return;
        d3.select(this.canvas).selectAll('svg').remove();

        var rect = this.canvas.getBoundingClientRect();
        this.width = Math.max(rect.width || 580, 400);
        this.height = 150;

        this.svg = d3.select(this.canvas)
            .append('svg')
            .attr('width', '100%')
            .attr('height', this.height)
            .attr('viewBox', '0 0 ' + this.width + ' ' + this.height)
            .attr('preserveAspectRatio', 'xMidYMid meet');

        this.bgLayer = this.svg.append('g').attr('class', 'bg-layer');
        this.laneLayer = this.svg.append('g').attr('class', 'lane-layer');
        this.particleLayer = this.svg.append('g').attr('class', 'particle-layer');
        this.labelLayer = this.svg.append('g').attr('class', 'label-layer');
    };

    LiveFlowViz.prototype.setEnabled = function(enabled) {
        this.enabled = enabled;
        if (this.emptyState) {
            this.emptyState.style.display = enabled ? 'none' : 'flex';
        }
        if (this.svg) {
            this.svg.style('display', enabled ? 'block' : 'none');
        }
        var legend = document.getElementById('liveFlowLegend');
        if (legend) {
            legend.style.display = enabled ? 'flex' : 'none';
        }
        if (enabled) {
            this._attachSSE();
        }
    };

    LiveFlowViz.prototype._attachSSE = function() {
        if (this._sseAttached) return;
        var es = STATE.sse.eventSource;
        if (es && es.readyState !== 2) {
            es.addEventListener('pool-status', this._sseHandler);
            this._sseAttached = true;
            this._setStatus('connected');
        } else {
            this._startFallbackPolling();
        }
    };

    LiveFlowViz.prototype._onPoolStatus = function(e) {
        try {
            var data = JSON.parse(e.data);
            this.poolData = data.pools || data;
            this._render();

            if (typeof window.modelRoutingData !== 'undefined' && window.modelRoutingData && data.pools) {
                window.modelRoutingData.pools = data.pools;
                if (typeof renderPoolStatus === 'function') {
                    renderPoolStatus(window.modelRoutingData);
                }
            }

            if (window._tierBuilder && data.pools) {
                window._tierBuilder.updatePoolStatus(data.pools);
            }
        } catch (err) {
            // Parse error, ignore
        }
    };

    LiveFlowViz.prototype._startFallbackPolling = function() {
        if (this._pollTimer) return;
        this._usePolling = true;
        this._setStatus('polling');
        var self = this;

        this._pollTimer = setInterval(async function() {
            if (!self.enabled) return;
            try {
                var res = await fetch('/model-routing/pools');
                if (res.ok) {
                    var pools = await res.json();
                    self.poolData = pools;
                    self._render();
                }
            } catch (_e) { /* ignore poll errors */ }
        }, 3000);
    };

    LiveFlowViz.prototype._stopFallbackPolling = function() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        this._usePolling = false;
    };

    LiveFlowViz.prototype._setStatus = function(status) {
        if (!this.statusEl) return;
        this.statusEl.className = 'live-flow-status ' + status;
        var labels = { connected: 'Live', polling: 'Polling', error: 'Disconnected' };
        this.statusEl.textContent = labels[status] || status;
    };

    LiveFlowViz.prototype._render = function() {
        if (!this.svg || !this.poolData || !this.enabled) return;

        var tiers = Object.entries(this.poolData);
        if (tiers.length === 0) return;

        var margin = { top: 20, right: 20, bottom: 10, left: 70 };
        var laneH = 30;
        var laneGap = 8;
        var modelW = 80;
        var modelGap = 10;
        var contentW = this.width - margin.left - margin.right;

        this._renderRequestNode(margin);

        var self = this;
        tiers.forEach(function(tierEntry, i) {
            var tierName = tierEntry[0];
            var models = tierEntry[1];
            var y = margin.top + i * (laneH + laneGap);

            var lanes = self.laneLayer.selectAll('.lane-bg-' + tierName).data([tierName]);
            lanes.enter()
                .append('rect')
                .attr('class', 'swim-lane-bg lane-bg-' + tierName)
                .merge(lanes)
                .attr('x', margin.left)
                .attr('y', y)
                .attr('width', contentW)
                .attr('height', laneH);

            var labels = self.labelLayer.selectAll('.lane-label-' + tierName).data([tierName]);
            labels.enter()
                .append('text')
                .attr('class', 'swim-lane-label lane-label-' + tierName)
                .merge(labels)
                .attr('x', margin.left - 8)
                .attr('y', y + laneH / 2)
                .attr('text-anchor', 'end')
                .attr('dominant-baseline', 'central')
                .text(tierName.charAt(0).toUpperCase() + tierName.slice(1));

            var modelData = Array.isArray(models) ? models : [];
            var modelSel = self.laneLayer.selectAll('.model-' + tierName)
                .data(modelData, function(d) { return d.model; });

            var entered = modelSel.enter()
                .append('g')
                .attr('class', 'model-' + tierName);
            entered.append('rect')
                .attr('class', 'swim-lane-model tier-' + tierName)
                .attr('height', laneH - 6)
                .attr('width', modelW);
            entered.append('text')
                .attr('class', 'swim-lane-model-label');

            var merged = entered.merge(modelSel);
            merged.attr('transform', function(d, j) {
                var x = margin.left + 10 + j * (modelW + modelGap);
                return 'translate(' + x + ', ' + (y + 3) + ')';
            });
            merged.select('rect')
                .attr('width', modelW)
                .attr('height', laneH - 6);
            merged.select('text')
                .attr('x', modelW / 2)
                .attr('y', (laneH - 6) / 2)
                .text(function(d) {
                    var name = d.model || '';
                    return name.length > 12 ? name.slice(0, 11) + '\u2026' : name;
                });

            modelSel.exit().remove();
        });

        if (!this.reducedMotion) {
            this._spawnParticles(tiers, margin, laneH, laneGap);
        }
    };

    LiveFlowViz.prototype._renderRequestNode = function(margin) {
        var existing = this.bgLayer.selectAll('.request-node').data([1]);
        var g = existing.enter().append('g').attr('class', 'request-node');
        g.append('circle')
            .attr('cx', 25).attr('cy', margin.top + 20).attr('r', 14)
            .attr('fill', 'var(--bg-card)').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
        g.append('text')
            .attr('x', 25).attr('y', margin.top + 24)
            .attr('text-anchor', 'middle').attr('font-size', '8px').attr('fill', 'var(--text-primary)')
            .text('Req');

        var arrowData = this.bgLayer.selectAll('.request-arrow').data([1]);
        arrowData.enter().append('line')
            .attr('class', 'request-arrow')
            .attr('x1', 39).attr('y1', margin.top + 20)
            .attr('x2', margin.left).attr('y2', margin.top + 20)
            .attr('stroke', 'var(--border)').attr('stroke-width', 1).attr('stroke-dasharray', '3,3');
    };

    LiveFlowViz.prototype._spawnParticles = function(tiers, margin, laneH, laneGap) {
        while (this.particles.length >= this.MAX_PARTICLES) {
            this.particles.shift();
        }

        var totalInFlight = tiers.reduce(function(sum, entry) {
            var models = entry[1];
            return sum + (Array.isArray(models) ? models.reduce(function(s, m) { return s + (m.inFlight || 0); }, 0) : 0);
        }, 0);

        if (totalInFlight === 0) {
            this.overflowCount = 0;
            this._updateParticleCounter();
            return;
        }

        this.overflowCount = Math.max(0, totalInFlight - this.MAX_PARTICLES);
        this._updateParticleCounter();

        var toAdd = Math.min(3, this.MAX_PARTICLES - this.particles.length);
        for (var i = 0; i < toAdd; i++) {
            var r = Math.random() * totalInFlight;
            var selectedTier = null;
            var tierIndex = 0;
            for (var t = 0; t < tiers.length; t++) {
                var tierEntry = tiers[t];
                var tierModels = tierEntry[1];
                var tierInFlight = Array.isArray(tierModels) ? tierModels.reduce(function(s, m) { return s + (m.inFlight || 0); }, 0) : 0;
                r -= tierInFlight;
                if (r <= 0) {
                    selectedTier = tierEntry[0];
                    tierIndex = t;
                    break;
                }
            }
            if (!selectedTier) {
                selectedTier = tiers[0][0];
                tierIndex = 0;
            }

            var y = margin.top + tierIndex * (laneH + laneGap) + laneH / 2;
            this.particles.push({
                id: ++this.particleId,
                tier: selectedTier,
                x: margin.left,
                y: y,
                targetX: margin.left + 10 + Math.random() * 200,
                speed: 1 + Math.random() * 2
            });
        }

        if (!this.rafId && !document.hidden) {
            this._animateParticles();
        }
    };

    LiveFlowViz.prototype._animateParticles = function() {
        if (this.reducedMotion || document.hidden) {
            this.rafId = null;
            return;
        }
        var self = this;

        this.particles = this.particles.filter(function(p) {
            p.x += p.speed;
            return p.x < self.width - 20;
        });

        var circles = this.particleLayer.selectAll('.flow-particle')
            .data(this.particles, function(d) { return d.id; });

        circles.enter()
            .append('circle')
            .attr('class', function(d) { return 'flow-particle tier-' + d.tier; })
            .attr('r', 3)
            .merge(circles)
            .attr('cx', function(d) { return d.x; })
            .attr('cy', function(d) { return d.y; });

        circles.exit().remove();

        if (this.particles.length > 0) {
            this.rafId = requestAnimationFrame(function() { self._animateParticles(); });
        } else {
            this.rafId = null;
        }
    };

    LiveFlowViz.prototype._updateParticleCounter = function() {
        var counterSel = this.labelLayer.selectAll('.particle-counter').data(
            this.overflowCount > 0 ? [this.overflowCount] : []
        );
        counterSel.enter()
            .append('text')
            .attr('class', 'particle-counter')
            .merge(counterSel)
            .attr('x', this.width - 30)
            .attr('y', 12)
            .text(function(d) { return '+' + d + ' more'; });
        counterSel.exit().remove();
    };

    LiveFlowViz.prototype._onVisibilityChange = function() {
        if (document.hidden) {
            if (this.rafId) {
                cancelAnimationFrame(this.rafId);
                this.rafId = null;
            }
        } else {
            if (this.particles.length > 0 && !this.reducedMotion) {
                this._animateParticles();
            }
        }
    };

    LiveFlowViz.prototype.destroy = function() {
        var es = STATE.sse.eventSource;
        if (es && this._sseAttached) {
            es.removeEventListener('pool-status', this._sseHandler);
            this._sseAttached = false;
        }
        this._stopFallbackPolling();
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        document.removeEventListener('visibilitychange', this._visHandler);
        this._motionQuery.removeEventListener('change', this._motionHandler);
        if (this.canvas) {
            d3.select(this.canvas).selectAll('svg').remove();
        }
        window._liveFlowViz = null;
    };

    function updateFlowDiagram(routingEnabled) {
        if (!window._liveFlowViz) {
            if (typeof d3 !== 'undefined') {
                window._liveFlowViz = new LiveFlowViz('liveFlowCanvas');
            }
        }
        if (window._liveFlowViz) {
            window._liveFlowViz.setEnabled(routingEnabled);
        }
    }

    // ========== FALLBACK CHAIN VISUALIZATION ==========
    function renderFallbackChains(data) {
        var container = document.getElementById('fallbackChainsViz');
        if (!container) return;
        if (!data?.config?.tiers) {
            container.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 12px;">No fallback chains configured</div>';
            return;
        }

        var cooldowns = data.cooldowns || {};
        var tiers = data.config.tiers;

        var getModelInfo = function(modelId) {
            var modelData = STATE.modelsData && STATE.modelsData[modelId];
            var displayName = modelData && modelData.displayName ? modelData.displayName : modelId;
            var tier = modelData && modelData.tier ? modelData.tier.toUpperCase() : '';
            return { displayName: displayName, tier: tier };
        };

        container.innerHTML = Object.entries(tiers).map(function(entry) {
            var name = entry[0], cfg = entry[1];
            var target = cfg.targetModel || '?';
            var fallbacks = Array.isArray(cfg.fallbackModels) ? cfg.fallbackModels : (cfg.failoverModel ? [cfg.failoverModel] : []);

            var nodes = [target].concat(fallbacks);
            var nodesHtml = nodes.map(function(model, i) {
                var cd = cooldowns[model];
                var isCooled = cd && cd.remainingMs > 0;
                var cls = i === 0 ? 'primary' : (isCooled ? 'cooled' : 'available');
                var info = getModelInfo(model);
                var tierBadgeClass = 'tier-badge-' + (info.tier ? info.tier.toLowerCase() : 'unknown');

                var statusHtml = '';
                if (isCooled) {
                    statusHtml = '<span class="chain-status chain-status-cooled" title="Cooled down - rate limited">' +
                        '<span aria-hidden="true">\u26A1</span> ' +
                        '<span class="visually-hidden">Cooled down, </span>' +
                        (cd.remainingMs / 1000).toFixed(0) + 's</span>';
                } else if (i > 0) {
                    statusHtml = '<span class="chain-status chain-status-available" title="Available">' +
                        '<span aria-hidden="true">\u2713</span><span class="visually-hidden">Available</span></span>';
                }

                return '<span class="chain-node ' + cls + '">' +
                    '<span class="chain-model-name">' + escapeHtml(info.displayName) + '</span>' +
                    '<span class="tier-badge ' + tierBadgeClass + '">' + (info.tier || '?') + '</span>' +
                    statusHtml + '</span>';
            }).join('<span class="chain-arrow" aria-hidden="true">\u2192</span>');

            return '<div class="fallback-chain-row" role="group" aria-label="' + escapeHtml(name) + ' tier fallback chain">' +
                '<span class="fallback-chain-label">' + escapeHtml(name) + '</span>' +
                nodesHtml + '</div>';
        }).join('');
    }

    // ========== POOL STATUS VISUALIZATION ==========
    function renderPoolStatus(data) {
        var section = document.getElementById('modelPoolsSection');
        var container = document.getElementById('modelPoolsViz');
        if (!section || !container) return;

        var pools = data?.pools;
        if (!pools || Object.keys(pools).length === 0) {
            section.style.display = 'none';
            return;
        }

        section.style.display = 'block';

        var getModelInfo = function(modelId) {
            var modelData = STATE.modelsData && STATE.modelsData[modelId];
            return modelData && modelData.displayName ? modelData.displayName : modelId;
        };

        container.innerHTML = Object.entries(pools).map(function(entry) {
            var tier = entry[0], models = entry[1];
            var totalSlots = models.reduce(function(sum, m) { return sum + m.maxConcurrency; }, 0);
            var totalInFlight = models.reduce(function(sum, m) { return sum + m.inFlight; }, 0);
            var utilPct = totalSlots > 0 ? Math.round((totalInFlight / totalSlots) * 100) : 0;

            var modelsHtml = models.map(function(m) {
                var pct = m.maxConcurrency > 0 ? Math.round((m.inFlight / m.maxConcurrency) * 100) : 0;
                var barClass = m.cooldownMs > 0 ? 'pool-bar-cooled' : (pct >= 80 ? 'pool-bar-high' : (pct >= 50 ? 'pool-bar-medium' : 'pool-bar-low'));
                var displayName = getModelInfo(m.model);
                var valueText = m.inFlight + '/' + m.maxConcurrency;
                var showInline = pct >= 25;

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
                '<span class="pool-tier-util">' + utilPct + '%</span></div>' +
                modelsHtml + '</div>';
        }).join('');
    }

    // Pool status polling
    var _poolPollTimer = null;
    function startPoolPolling() {
        if (_poolPollTimer) return;
        _poolPollTimer = setInterval(async function() {
            var section = document.getElementById('modelPoolsSection');
            if (!section || section.style.display === 'none') return;
            try {
                var res = await fetch('/model-routing/pools');
                if (res.ok) {
                    var pools = await res.json();
                    if (window.modelRoutingData) {
                        window.modelRoutingData.pools = pools;
                        renderPoolStatus(window.modelRoutingData);
                    }
                    if (window._tierBuilder && window.modelRoutingData.pools) {
                        window._tierBuilder.updatePoolStatus(window.modelRoutingData.pools);
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

    // ========== ROUTING COOLDOWNS & OVERRIDES ==========
    function renderRoutingCooldowns() {
        var cooldownBody = document.getElementById('routingCooldownBody');
        if (!cooldownBody || !window.modelRoutingData) return;
        var cooldowns = window.modelRoutingData.cooldowns || {};
        var entries = Object.entries(cooldowns);
        if (entries.length === 0) {
            cooldownBody.innerHTML = '<tr><td colspan="3" style="color: var(--text-secondary);">None</td></tr>';
            return;
        }
        cooldownBody.innerHTML = entries.map(function(entry) {
            var model = entry[0], info = entry[1];
            return '<tr' + (info.burstDampened ? ' style="opacity:0.7"' : '') + '>' +
                '<td>' + escapeHtml(model) + (info.burstDampened ? ' <span style="color:var(--warning);font-size:0.7rem;">(burst)</span>' : '') + '</td>' +
                '<td>' + (info.remainingMs / 1000).toFixed(1) + 's</td>' +
                '<td>' + info.count + '</td></tr>';
        }).join('');
    }

    function renderRoutingOverrides() {
        var overrideBody = document.getElementById('routingOverrideBody');
        if (!overrideBody || !window.modelRoutingData) return;
        var overrides = window.modelRoutingData.overrides || {};
        var entries = Object.entries(overrides);
        if (entries.length === 0) {
            overrideBody.innerHTML = '<tr><td colspan="3" style="color: var(--text-secondary);">None</td></tr>';
            return;
        }
        overrideBody.innerHTML = entries.map(function(entry) {
            var key = entry[0], model = entry[1];
            return '<tr><td>' + escapeHtml(key) + '</td>' +
                '<td>' + escapeHtml(model) + '</td>' +
                '<td><button class="btn btn-danger btn-small" data-action="remove-routing-override" data-key="' + escapeHtml(key) + '">Remove</button></td></tr>';
        }).join('');
    }

    // ========== EXPORT ==========
    window.DashboardLiveFlow = {
        LiveFlowViz: LiveFlowViz,
        updateFlowDiagram: updateFlowDiagram,
        renderFallbackChains: renderFallbackChains,
        renderPoolStatus: renderPoolStatus,
        startPoolPolling: startPoolPolling,
        stopPoolPolling: stopPoolPolling,
        renderRoutingCooldowns: renderRoutingCooldowns,
        renderRoutingOverrides: renderRoutingOverrides
    };

})(window);
