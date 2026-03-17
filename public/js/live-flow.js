/**
 * live-flow.js — Runway Per-Request Flow Visualization
 * Phase 6: Split from dashboard.js
 *
 * Provides: window.DashboardLiveFlow
 * Contains: RunwayViz class, fallback chain visualization,
 * pool status visualization, routing cooldowns/overrides.
 */
(function(window) {
    'use strict';

    var DS = window.DashboardStore;
    var STATE = DS.STATE;
    var FEATURES = DS.FEATURES;
    var escapeHtml = DS.escapeHtml;
    var authFetch = DS.authFetch;
    var showToast = window.showToast;

    // ========== RUNWAY PER-REQUEST FLOW VISUALIZATION ==========
    var MAX_VISIBLE_ROWS = 30;
    var MAX_COMPLETED = 15;
    var COMPLETED_EXPIRY_MS = 30000;
    var STALE_THRESHOLD_MS = 120000;
    var COMPACT_RATE_THRESHOLD = 100; // req/min

    function RunwayViz() {
        this.container = document.getElementById('runwayViz');
        this.streamEl = document.getElementById('runwayStream');
        this.rowsEl = document.getElementById('runwayRows');
        if (this.rowsEl) this.rowsEl.setAttribute('role', 'list');
        this.jumpEl = document.getElementById('runwayJump');
        this.jumpBtn = document.getElementById('runwayJumpBtn');
        this.emptyEl = document.getElementById('runwayEmpty');
        this.footerEl = document.getElementById('runwayFooter');
        this.statusEl = document.getElementById('liveFlowStatus');

        // Auto-scroll state
        this._autoScroll = true;
        this._userScrolling = false;

        this.enabled = false;
        this.inFlight = new Map();    // requestId -> RunwayRow
        this.completed = [];           // RunwayRow[] (FIFO, max 5)
        this.requestRate = { count: 0, windowStart: Date.now() };

        this._progressTimer = null;
        this._sseAttached = false;
        this._usePolling = false;
        this._pollTimer = null;
        this._compactDebounce = null;
        this._renderPending = false;

        // Reduced motion detection
        this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this._motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        var self = this;
        this._motionHandler = function(e) { self.reducedMotion = e.matches; };
        this._motionQuery.addEventListener('change', this._motionHandler);

        // Visibility handling
        this._visHandler = function() { self._onVisibilityChange(); };
        document.addEventListener('visibilitychange', this._visHandler);

        // Scroll handling for auto-follow
        this._scrollHandler = function() { self._onScroll(); };
        if (this.streamEl) {
            this.streamEl.addEventListener('scroll', this._scrollHandler, { passive: true });
        }
        if (this.jumpBtn) {
            this.jumpBtn.addEventListener('click', function() {
                self._scrollToBottom();
                self._autoScroll = true;
                if (self.jumpEl) self.jumpEl.style.display = 'none';
            });
        }

        // Probe progress state
        this._probeActive = false;
        this._probeProgress = null;

        // Upstream detail fetch throttle
        this._lastUpstreamDetailFetch = 0;

        // SSE handlers
        this._onRequestStart = function(e) { self._handleRequestStart(e); };
        this._onRequestRetry = function(e) { self._handleRequestRetry(e); };
        this._onRequestComplete = function(e) { self._handleRequestComplete(e); };
        this._onPoolStatus = function(e) { self._handlePoolStatus(e); };
        this._onProbeStatus = function(e) { self._handleProbeStatus(e); };
        this._onUpstreamHealth = function(e) { self._handleUpstreamHealth(e); };
        this._onUpstreamFailover = function(e) { self._handleUpstreamFailover(e); };

        this._updateEmpty();
    }

    RunwayViz.prototype.setEnabled = function(enabled) {
        this.enabled = enabled;
        if (enabled) {
            this._attachSSE();
            this._startProgressTimer();
        } else {
            this._stopProgressTimer();
        }
        this._updateEmpty();
    };

    RunwayViz.prototype._attachSSE = function() {
        if (this._sseAttached) return;
        var es = STATE.sse.eventSource;
        if (es && es.readyState !== 2) {
            es.addEventListener('request-start', this._onRequestStart);
            es.addEventListener('request-retry', this._onRequestRetry);
            es.addEventListener('request-complete', this._onRequestComplete);
            es.addEventListener('pool-status', this._onPoolStatus);
            es.addEventListener('probe-status', this._onProbeStatus);
            es.addEventListener('upstream-health', this._onUpstreamHealth);
            es.addEventListener('upstream-failover', this._onUpstreamFailover);
            this._sseAttached = true;
            this._setStatus('connected');
        } else {
            this._startFallbackPolling();
        }
    };

    RunwayViz.prototype._detachSSE = function() {
        var es = STATE.sse.eventSource;
        if (es && this._sseAttached) {
            es.removeEventListener('request-start', this._onRequestStart);
            es.removeEventListener('request-retry', this._onRequestRetry);
            es.removeEventListener('request-complete', this._onRequestComplete);
            es.removeEventListener('pool-status', this._onPoolStatus);
            es.removeEventListener('probe-status', this._onProbeStatus);
            es.removeEventListener('upstream-health', this._onUpstreamHealth);
            es.removeEventListener('upstream-failover', this._onUpstreamFailover);
            this._sseAttached = false;
        }
    };

    // -- SSE Event Handlers --

    RunwayViz.prototype._handleRequestStart = function(e) {
        try {
            var data = JSON.parse(e.data);
            // Skip requests with no model info (non-LLM admin requests)
            var model = data.mappedModel || data.originalModel;
            if (!model) return;
            var row = {
                requestId: data.requestId,
                shortId: (data.requestId || '').slice(-4),
                originalModel: data.originalModel || null,
                mappedModel: model,
                tier: data.tier || null,
                startTime: data.timestamp || Date.now(),
                endTime: null,
                status: data.mappedModel ? 'processing' : 'routing',
                retries: [],
                latencyMs: 0,
                inputTokens: 0,
                outputTokens: 0,
                phase: 'send',
                phaseStartTime: data.timestamp || Date.now(),
                el: null,
                progressEl: null,
                recvEl: null,
                expiryTimer: null
            };
            this.inFlight.set(data.requestId, row);
            this._trackRate();
            this._scheduleRender();
            this._updateEmpty();
        } catch (err) { /* parse error */ }
    };

    RunwayViz.prototype._handleRequestRetry = function(e) {
        try {
            var data = JSON.parse(e.data);
            var row = this.inFlight.get(data.requestId);
            if (!row) return; // orphan retry, ignore
            row.retries.push({
                model: data.previousModel || row.mappedModel,
                errorType: data.errorType || 'unknown'
            });
            row.mappedModel = data.mappedModel || row.mappedModel;
            row.status = 'processing';
            this._scheduleRender();
        } catch (err) { /* parse error */ }
    };

    RunwayViz.prototype._handleRequestComplete = function(e) {
        try {
            var self = this;
            var data = JSON.parse(e.data);
            var id = data.requestId;
            var row = this.inFlight.get(id);

            if (!row) {
                // Orphan: request-complete without request-start — synthesize completed row
                // Skip orphans with no model info (admin/non-LLM requests or stale events)
                var orphanModel = data.mappedModel || data.originalModel || (data.routingDecision && data.routingDecision.mappedModel) || null;
                if (!orphanModel) return;
                row = {
                    requestId: id,
                    shortId: (id || '').slice(-4),
                    originalModel: data.originalModel || null,
                    mappedModel: orphanModel,
                    tier: data.routingDecision?.tier || null,
                    startTime: (data.timestamp || Date.now()) - (data.latency || data.latencyMs || 0),
                    endTime: data.timestamp || Date.now(),
                    status: data.error ? 'error' : 'completed',
                    retries: [],
                    latencyMs: data.latency || data.latencyMs || 0,
                    inputTokens: data.inputTokens || 0,
                    outputTokens: data.outputTokens || 0,
                    phase: 'done',
                    phaseStartTime: Date.now(),
                    el: null,
                    progressEl: null,
                    recvEl: null,
                    expiryTimer: null
                };
                this._addToCompleted(row);
                return;
            }

            // Transition to recv phase
            row.endTime = data.timestamp || Date.now();
            row.latencyMs = data.latency || data.latencyMs || (row.endTime - row.startTime);
            row.inputTokens = data.inputTokens || 0;
            row.outputTokens = data.outputTokens || 0;
            row.mappedModel = data.mappedModel || row.mappedModel;
            row.status = data.error ? 'error' : 'completed';
            row.phase = 'recv';
            row.phaseStartTime = Date.now();

            // Snap send bar to 100% and show incoming tokens
            if (row.el) {
                var sendBar = row.el.querySelector('.runway-bar-send');
                if (sendBar) sendBar.style.transform = 'scaleX(1)';
                row.el.setAttribute('data-phase', 'recv');
                // Show token count flowing in during recv
                var timingEl = row.el.querySelector('.runway-timing');
                if (timingEl && row.outputTokens > 0) {
                    timingEl.textContent = self._formatElapsed(row.latencyMs) + ' \u2190' + self._formatTokens(row.outputTokens);
                }
            }

            // Minimum visual hold before moving to completed
            // Fast requests get more hold time so the user can see them
            var elapsed = row.latencyMs || (Date.now() - row.startTime);
            var recvHoldMs = elapsed < 800 ? 400 : 300;

            setTimeout(function() {
                if (!self.rowsEl) return; // destroyed
                self.inFlight.delete(id);
                row.phase = 'done';
                self._addToCompleted(row);
                self._renderStream();
                self._updateEmpty();
            }, recvHoldMs);

        } catch (err) { /* parse error */ }
    };

    RunwayViz.prototype._addToCompleted = function(row) {
        this.completed.unshift(row);
        while (this.completed.length > MAX_COMPLETED) {
            var removed = this.completed.pop();
            if (removed && removed.expiryTimer) clearTimeout(removed.expiryTimer);
        }

        var self = this;
        row.expiryTimer = setTimeout(function() {
            var idx = self.completed.indexOf(row);
            if (idx >= 0) {
                self.completed.splice(idx, 1);
                self._renderStream();
                self._updateEmpty();
            }
        }, COMPLETED_EXPIRY_MS);

        this._renderStream();
        this._updateEmpty();
    };

    RunwayViz.prototype._handlePoolStatus = function(e) {
        // Forward to pool status renderers (keep existing behavior)
        try {
            var data = JSON.parse(e.data);
            if (typeof window.modelRoutingData !== 'undefined' && window.modelRoutingData && data.pools) {
                window.modelRoutingData.pools = data.pools;
                if (typeof renderPoolStatus === 'function') {
                    renderPoolStatus(window.modelRoutingData);
                }
            }
            if (window._tierBuilder && data.pools) {
                window._tierBuilder.updatePoolStatus(data.pools);
            }
        } catch (err) { /* parse error */ }
    };

    RunwayViz.prototype._handleProbeStatus = function(e) {
        try {
            var data = JSON.parse(e.data);
            if (!this.footerEl) return;

            if (data.status === 'started') {
                this._probeActive = true;
                this.footerEl.setAttribute('data-probing', 'true');
            } else if (data.status === 'probing') {
                this._probeActive = true;
                this._probeProgress = data.progress + '/' + data.total;
            } else if (data.status === 'completed') {
                this._probeActive = false;
                this._probeProgress = null;
                this.footerEl.removeAttribute('data-probing');
                // Brief completion message
                var msg = 'Probe done: ' + (data.verified || 0) + ' verified, ' + (data.discovered || 0) + ' new';
                this.footerEl.textContent = msg;
                var self = this;
                setTimeout(function() { self._updateFooter(); }, 5000);
                return;
            }
            this._updateFooter();
        } catch (err) { /* parse error */ }
    };

    RunwayViz.prototype._handleUpstreamHealth = function(e) {
        try {
            var data = JSON.parse(e.data);
            this._upstreamState = data.state;
            this._upstreamData = data;

            // 1. Update runway status indicator
            if (this.statusEl) {
                if (data.state === 'down') {
                    this.statusEl.className = 'live-flow-status error';
                    var dur = data.outage ? Math.round(data.outage.durationMs / 1000) + 's' : '';
                    this.statusEl.textContent = 'Upstream DOWN ' + dur;
                    this.statusEl.title = 'Active: ' + (data.activeEndpoint || '?') + (data.isPrimary ? '' : ' (failover)');
                } else if (data.state === 'degraded') {
                    this.statusEl.className = 'live-flow-status polling';
                    this.statusEl.textContent = 'Degraded';
                } else if (!data.isPrimary) {
                    this.statusEl.className = 'live-flow-status polling';
                    this.statusEl.textContent = 'Failover: ' + data.activeEndpoint;
                } else if (data.state === 'healthy') {
                    this.statusEl.className = 'live-flow-status connected';
                    this.statusEl.textContent = 'Live';
                }
            }

            // 2. Update header upstream badge
            var badge = document.getElementById('headerUpstreamBadge');
            if (badge) {
                if (data.state === 'down') {
                    badge.style.display = '';
                    badge.className = 'upstream-badge down';
                    badge.textContent = 'DOWN';
                    badge.title = 'Upstream down' + (data.outage ? ' (' + Math.round(data.outage.durationMs / 1000) + 's)' : '');
                } else if (data.state === 'degraded') {
                    badge.style.display = '';
                    badge.className = 'upstream-badge degraded';
                    badge.textContent = 'DEGRADED';
                    badge.title = 'Some upstream IPs failing';
                } else if (!data.isPrimary) {
                    badge.style.display = '';
                    badge.className = 'upstream-badge failover';
                    badge.textContent = 'FAILOVER';
                    badge.title = 'Using fallback: ' + data.activeEndpoint;
                } else {
                    badge.style.display = 'none';
                }
            }

            // 3. Update header connection dot color based on upstream
            var dot = document.getElementById('connectionDot');
            if (dot) {
                if (data.state === 'down') {
                    dot.className = 'connection-dot error';
                } else if (data.state === 'degraded') {
                    dot.className = 'connection-dot stale';
                } else {
                    dot.className = 'connection-dot connected';
                }
            }

            // 4. Update diagnostics panel
            this._updateUpstreamPanel(data);

            // Fetch full details for diagnostics panel (throttled)
            var now = Date.now();
            if (now - this._lastUpstreamDetailFetch > 15000) {
                this._lastUpstreamDetailFetch = now;
                this.fetchUpstreamDetails();
            }

        } catch (err) { /* parse error */ }
    };

    RunwayViz.prototype._updateUpstreamPanel = function(data) {
        // State indicator
        var stateEl = document.getElementById('upstreamState');
        var dotEl = document.getElementById('upstreamDot');
        var endpointEl = document.getElementById('upstreamEndpoint');
        if (stateEl) {
            var stateLabels = { healthy: 'Healthy', degraded: 'Degraded', down: 'Down' };
            stateEl.textContent = stateLabels[data.state] || data.state;
            stateEl.className = 'upstream-state ' + data.state;
        }
        if (dotEl) {
            dotEl.className = 'upstream-dot ' + data.state;
        }
        if (endpointEl) {
            endpointEl.textContent = data.activeEndpoint + (data.isPrimary ? '' : ' (failover)');
            endpointEl.className = 'upstream-endpoint' + (!data.isPrimary ? ' failover' : '');
        }

        // Outage section
        var outageEl = document.getElementById('upstreamOutage');
        var outageDurEl = document.getElementById('upstreamOutageDuration');
        var outageDetailsEl = document.getElementById('upstreamOutageDetails');
        if (outageEl) {
            if (data.outage) {
                outageEl.style.display = '';
                if (outageDurEl) {
                    var secs = Math.round(data.outage.durationMs / 1000);
                    outageDurEl.textContent = secs < 60 ? secs + 's' : Math.round(secs / 60) + 'm ' + (secs % 60) + 's';
                }
                if (outageDetailsEl) {
                    outageDetailsEl.textContent = 'Started: ' + new Date(data.outage.startedAt).toLocaleTimeString();
                }
            } else {
                outageEl.style.display = 'none';
            }
        }
    };

    RunwayViz.prototype._toggleRowDetail = function(el, row) {
        // Toggle existing detail
        var existing = el.nextElementSibling;
        if (existing && existing.classList.contains('runway-row-detail')) {
            existing.remove();
            this._expandedRowId = null;
            return;
        }

        // Remove any other open details
        var openDetails = document.querySelectorAll('.runway-row-detail');
        for (var i = 0; i < openDetails.length; i++) openDetails[i].remove();

        // Track expanded row so it persists across re-renders
        this._expandedRowId = row.requestId;

        // Build detail pane
        var detail = document.createElement('div');
        detail.className = 'runway-row-detail';

        var lines = [];
        lines.push('<span class="detail-label">Request</span><span class="detail-value">' + escapeHtml(row.requestId || '?') + '</span>');
        if (row.originalModel) {
            lines.push('<span class="detail-label">Original</span><span class="detail-value">' + escapeHtml(row.originalModel) + '</span>');
        }
        lines.push('<span class="detail-label">Mapped</span><span class="detail-value">' + escapeHtml(row.mappedModel || '?') + '</span>');
        if (row.tier) {
            lines.push('<span class="detail-label">Tier</span><span class="detail-value">' + escapeHtml(row.tier) + '</span>');
        }
        if (row.latencyMs > 0) {
            lines.push('<span class="detail-label">Latency</span><span class="detail-value">' + this._formatElapsed(row.latencyMs) + '</span>');
        }
        if (row.inputTokens || row.outputTokens) {
            lines.push('<span class="detail-label">Tokens</span><span class="detail-value">' + (row.inputTokens || 0) + ' in \u2192 ' + (row.outputTokens || 0) + ' out</span>');
        }
        if (row.retries.length > 0) {
            var retryStr = row.retries.map(function(r) { return r.model + ' (' + r.errorType + ')'; }).join(' \u2192 ');
            lines.push('<span class="detail-label">Retries</span><span class="detail-value detail-retries">' + escapeHtml(retryStr) + '</span>');
        }
        if (row.status === 'error') {
            lines.push('<span class="detail-label">Status</span><span class="detail-value detail-error">Error</span>');
        }

        // Timing waterfall (visual bar showing request phases)
        var waterfallHtml = '';
        if (row.latencyMs > 0) {
            var total = row.latencyMs;
            // Estimate phases (we don't have exact TTFB, approximate from timing)
            var sendPct = Math.min(30, Math.max(5, 15)); // ~15% for request send
            var waitPct = Math.min(70, Math.max(20, 50)); // ~50% waiting for first byte
            var recvPct = 100 - sendPct - waitPct;         // remainder for receiving

            waterfallHtml = '<div class="detail-waterfall">' +
                '<div class="waterfall-bar">' +
                    '<div class="waterfall-seg send" style="width:' + sendPct + '%" title="Send ' + Math.round(total * sendPct / 100) + 'ms"></div>' +
                    '<div class="waterfall-seg wait" style="width:' + waitPct + '%" title="Wait ' + Math.round(total * waitPct / 100) + 'ms"></div>' +
                    '<div class="waterfall-seg recv" style="width:' + recvPct + '%" title="Receive ' + Math.round(total * recvPct / 100) + 'ms"></div>' +
                '</div>' +
                '<div class="waterfall-labels">' +
                    '<span>send</span><span>wait</span><span>recv</span>' +
                '</div>' +
            '</div>';
        }

        detail.innerHTML = '<div class="detail-grid">' + lines.join('') + '</div>' + waterfallHtml;

        // Insert after the row
        el.parentNode.insertBefore(detail, el.nextSibling);
    };

    RunwayViz.prototype.fetchUpstreamDetails = function() {
        authFetch('/upstream-health').then(function(res) { return res.json(); }).then(function(data) {
            // IP health table
            var ipsEl = document.getElementById('upstreamIPs');
            if (ipsEl && data.ipHealth) {
                var rows = Object.entries(data.ipHealth).map(function(entry) {
                    var ip = entry[0], h = entry[1];
                    return '<div class="upstream-ip-row">' +
                        '<span class="upstream-ip-dot ' + (h.healthy ? 'ok' : 'bad') + '"></span>' +
                        '<span class="upstream-ip-addr">' + ip + '</span>' +
                        '<span class="upstream-ip-latency">' + (h.latencyMs || '?') + 'ms</span>' +
                        (h.error ? '<span class="upstream-ip-error">' + h.error + '</span>' : '') +
                        '</div>';
                }).join('');
                ipsEl.innerHTML = rows || '<div class="text-secondary">No IP data yet</div>';
            }

            // Outage history
            var histEl = document.getElementById('upstreamHistory');
            if (histEl && data.history && data.history.length > 0) {
                var histRows = data.history.map(function(o) {
                    var dur = o.durationMs ? (o.durationMs < 60000 ? Math.round(o.durationMs/1000) + 's' : Math.round(o.durationMs/60000) + 'm') : '?';
                    return '<div class="upstream-history-row">' +
                        '<span>' + new Date(o.startedAt).toLocaleString() + '</span>' +
                        '<span class="upstream-history-duration">' + dur + '</span>' +
                        (o.failoverEndpoint ? '<span class="upstream-history-failover">' + o.failoverEndpoint + '</span>' : '') +
                        '</div>';
                }).join('');
                histEl.innerHTML = '<h5>Recent Outages</h5>' + histRows;
            }

            // Failover endpoints
            var failoverEl = document.getElementById('upstreamFailoverList');
            if (failoverEl) {
                var primary = '<div class="upstream-failover-row primary">' +
                    '<span class="upstream-failover-dot ok"></span>' +
                    '<span>api.z.ai</span>' +
                    '<span class="upstream-failover-label">Primary</span>' +
                    '</div>';
                var fallbacks = (data.history ? '' : '') + // placeholder
                    '<div class="upstream-failover-row">' +
                    '<span class="upstream-failover-dot standby"></span>' +
                    '<span>open.bigmodel.cn</span>' +
                    '<span class="upstream-failover-label">Fallback</span>' +
                    '</div>';
                failoverEl.innerHTML = primary + fallbacks;
            }
        }).catch(function() { /* ignore fetch errors */ });
    };

    RunwayViz.prototype._handleUpstreamFailover = function(e) {
        try {
            var data = JSON.parse(e.data);
            if (showToast) {
                showToast('Upstream failover: ' + data.from + ' \u2192 ' + data.to, 'warning');
            }
        } catch (err) { /* parse error */ }
    };

    // -- Rate Tracking --

    RunwayViz.prototype._trackRate = function() {
        var now = Date.now();
        if (now - this.requestRate.windowStart > 60000) {
            this.requestRate = { count: 1, windowStart: now };
        } else {
            this.requestRate.count++;
        }
        // Debounce compact mode check (reads offsetWidth = layout thrash)
        if (!this._compactDebounce) {
            var self = this;
            this._compactDebounce = setTimeout(function() {
                self._compactDebounce = null;
                self._updateCompactMode();
            }, 500);
        }
    };

    RunwayViz.prototype._updateCompactMode = function() {
        if (!this.container) return;
        var ratePerMin = this.requestRate.count;
        var isCompact = ratePerMin >= COMPACT_RATE_THRESHOLD || this.inFlight.size > 50;
        // Also compact at narrow widths
        if (this.container.offsetWidth < 600) isCompact = true;
        this.container.classList.toggle('compact', isCompact);
    };

    // -- Progress Timer --

    RunwayViz.prototype._startProgressTimer = function() {
        if (this._progressTimer) return;
        var self = this;
        this._progressTimer = setInterval(function() {
            if (self.inFlight.size === 0 || document.hidden) return;
            var now = Date.now();
            self.inFlight.forEach(function(row) {
                if (!row.el) return;
                var elapsed = now - row.startTime;

                // Update timing display
                var timingEl = row.el.querySelector('.runway-timing');
                if (timingEl) {
                    timingEl.textContent = self._formatElapsed(elapsed);
                }

                // Elapsed time color shift: fast (<2s), normal (2-10s), slow (>10s)
                var elapsedClass = elapsed < 2000 ? 'fast' : (elapsed < 10000 ? 'normal' : 'slow');
                row.el.setAttribute('data-elapsed', elapsedClass);

                // Mark stale
                if (elapsed > STALE_THRESHOLD_MS) {
                    row.el.classList.add('stale');
                }

                // Animate send bar (left→right)
                if (row.phase === 'send' && row.progressEl) {
                    if (row.status === 'processing') {
                        var sendPct = Math.min(0.85, elapsed / 20000);
                        row.progressEl.style.transform = 'scaleX(' + sendPct + ')';
                    } else if (row.status === 'routing') {
                        row.progressEl.style.transform = 'scaleX(' + Math.min(0.15, elapsed / 5000) + ')';
                    }
                }

                // Animate recv bar (left→right, same direction as send) during recv phase
                if (row.phase === 'recv' && row.recvEl) {
                    var recvElapsed = now - row.phaseStartTime;
                    var recvPct = Math.min(1, recvElapsed / 300);
                    row.recvEl.style.transform = 'scaleX(' + recvPct + ')';
                }
            });
        }, 100);
    };

    RunwayViz.prototype._stopProgressTimer = function() {
        if (this._progressTimer) {
            clearInterval(this._progressTimer);
            this._progressTimer = null;
        }
    };

    // -- Rendering --

    RunwayViz.prototype._renderStream = function() {
        if (!this.rowsEl) return;

        // Build unified list: completed (oldest first) then in-flight (priority sorted)
        var inflightRows = Array.from(this.inFlight.values());
        inflightRows.sort(function(a, b) {
            var scoreA = (a.status === 'error' ? 1000 : 0) + (a.retries.length * 100) + (Date.now() - a.startTime) / 1000;
            var scoreB = (b.status === 'error' ? 1000 : 0) + (b.retries.length * 100) + (Date.now() - b.startTime) / 1000;
            return scoreB - scoreA;
        });

        var visible = inflightRows.slice(0, MAX_VISIBLE_ROWS);
        var completedReversed = this.completed.slice().reverse(); // oldest first

        var fragment = document.createDocumentFragment();
        var self = this;

        // Completed rows first (oldest at top)
        completedReversed.forEach(function(row) {
            fragment.appendChild(self._createRowElement(row, true));
        });

        // In-flight rows after (newest activity at bottom)
        visible.forEach(function(row) {
            var el = self._createRowElement(row, false);
            row.el = el;
            row.progressEl = el.querySelector('.runway-bar-send');
            row.recvEl = el.querySelector('.runway-bar-recv');
            fragment.appendChild(el);
        });

        this.rowsEl.innerHTML = '';
        this.rowsEl.appendChild(fragment);

        // Re-expand detail pane if one was open before re-render
        if (this._expandedRowId) {
            var expId = this._expandedRowId;
            var expandedEl = this.rowsEl.querySelector('[data-request-id="' + expId + '"]');
            if (expandedEl) {
                var expandedRow = this.inFlight.get(expId) ||
                    this.completed.find(function(r) { return r.requestId === expId; });
                if (expandedRow) {
                    // Temporarily clear to prevent _toggleRowDetail from resetting it
                    this._expandedRowId = null;
                    this._toggleRowDetail(expandedEl, expandedRow);
                    this._expandedRowId = expId;
                }
            }
        }

        // Auto-scroll to bottom if following (deferred to avoid forced reflow)
        if (this._autoScroll) {
            var self = this;
            var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function(cb) { cb(); };
            raf(function() { self._scrollToBottom(); });
        }

        this._updateFooter();
    };

    RunwayViz.prototype._scheduleRender = function() {
        if (this._renderPending) return;
        this._renderPending = true;
        var self = this;
        var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function(cb) { cb(); };
        raf(function() {
            self._renderPending = false;
            self._renderStream();
        });
    };

    RunwayViz.prototype._createRowElement = function(row, isCompleted) {
        var el = document.createElement('div');
        el.className = 'runway-row';
        if (isCompleted) el.classList.add('completed');
        if (row.status === 'error') el.classList.add('error-row');
        if (!this.reducedMotion && !isCompleted) el.classList.add('runway-row-entering');
        el.setAttribute('data-request-id', row.requestId || '');
        el.setAttribute('data-status', row.status);
        if (row.phase) el.setAttribute('data-phase', row.phase);
        if (row.tier) el.setAttribute('data-tier', row.tier);

        // Hover tooltip with full details
        var tooltip = (row.originalModel || '?') + ' \u2192 ' + (row.mappedModel || '?');
        if (row.tier) tooltip += ' [' + row.tier + ']';
        if (row.latencyMs > 0) tooltip += ' ' + this._formatElapsed(row.latencyMs);
        if (row.retries.length > 0) tooltip += ' (' + row.retries.length + ' retries)';
        el.title = tooltip;
        el.setAttribute('role', 'listitem');
        el.setAttribute('aria-label', tooltip);

        // Click to expand inline details
        var self2 = this;
        el.style.cursor = 'pointer';
        el.addEventListener('click', function() {
            self2._toggleRowDetail(el, row);
        });

        // ID
        var idEl = document.createElement('span');
        idEl.className = 'runway-id';
        if (isCompleted) {
            idEl.textContent = (row.status === 'error' ? '\u2715 ' : '\u2713 ') + '#' + escapeHtml(row.shortId);
        } else {
            idEl.textContent = '#' + escapeHtml(row.shortId);
        }

        // Track — split layout: [retries?] [send-bar] [→] [model●] [→] [recv-bar]
        var trackEl = document.createElement('div');
        trackEl.className = 'runway-track';

        // Retry chain (compact, before send bar)
        if (row.retries.length > 0) {
            var retriesWrap = document.createElement('span');
            retriesWrap.className = 'runway-retries';
            for (var i = 0; i < row.retries.length; i++) {
                var retry = row.retries[i];
                var errModel = document.createElement('span');
                errModel.className = 'runway-model error';
                errModel.textContent = this._shortModelName(retry.model);
                retriesWrap.appendChild(errModel);

                var badge = document.createElement('span');
                badge.className = 'runway-badge error';
                badge.textContent = retry.errorType === 'rate_limited' ? '429' : (retry.errorType || 'err');
                retriesWrap.appendChild(badge);

                var retryArrow = document.createElement('span');
                retryArrow.className = 'runway-retry';
                retryArrow.textContent = '\u21BB';
                retriesWrap.appendChild(retryArrow);
            }
            trackEl.appendChild(retriesWrap);
        }

        // Request weight — bar height based on tier
        var barHeight = row.tier === 'heavy' ? '5px' : (row.tier === 'light' ? '2px' : '3px');

        // Send bar (left of model — request going out)
        var sendBar = document.createElement('div');
        sendBar.className = 'runway-bar-send';
        sendBar.style.height = barHeight;
        if (isCompleted || row.phase === 'recv' || row.phase === 'done') {
            sendBar.style.transform = 'scaleX(1)';
        }
        trackEl.appendChild(sendBar);

        // Arrow in (→ toward model)
        var arrowIn = document.createElement('span');
        arrowIn.className = 'runway-arrow runway-arrow-in';
        arrowIn.textContent = '\u25B8';
        trackEl.appendChild(arrowIn);

        // Model chip with tier pip
        var modelEl = document.createElement('span');
        modelEl.className = 'runway-model' + (row.status !== 'error' && !isCompleted ? ' active' : '');
        if (row.tier) modelEl.setAttribute('data-tier', row.tier);
        var pip = document.createElement('span');
        pip.className = 'runway-tier-pip';
        modelEl.appendChild(pip);
        var modelText = document.createTextNode(this._shortModelName(row.mappedModel));
        modelEl.appendChild(modelText);
        trackEl.appendChild(modelEl);

        // Arrow out (→ from model, response direction)
        var arrowOut = document.createElement('span');
        arrowOut.className = 'runway-arrow runway-arrow-out';
        arrowOut.textContent = '\u25B8';
        trackEl.appendChild(arrowOut);

        // Recv bar (right of model — response coming back)
        var recvBar = document.createElement('div');
        recvBar.className = 'runway-bar-recv';
        recvBar.style.height = barHeight;
        if (isCompleted) {
            recvBar.style.transform = 'scaleX(1)';
        }
        trackEl.appendChild(recvBar);

        // Timing
        var timingEl = document.createElement('span');
        timingEl.className = 'runway-timing';
        if (isCompleted) {
            var latStr = this._formatElapsed(row.latencyMs);
            var tokStr = '';
            if (row.inputTokens || row.outputTokens) {
                tokStr = ' ' + this._formatTokens(row.inputTokens) + '\u2192' + this._formatTokens(row.outputTokens);
            }
            timingEl.textContent = latStr + tokStr;
        } else {
            timingEl.textContent = this._formatElapsed(Date.now() - row.startTime);
        }

        el.appendChild(idEl);
        el.appendChild(trackEl);
        el.appendChild(timingEl);

        return el;
    };

    // -- Helpers --

    RunwayViz.prototype._shortModelName = function(model) {
        if (!model || model === 'null' || model === 'undefined') return '\u2014'; // em-dash instead of ?
        var name = model.replace(/-latest$/, '');
        if (name.startsWith('claude-')) return name.replace('claude-', 'c-');
        if (name.startsWith('glm-') && name.length > 9) return name.slice(4); // glm-4.5-air → 4.5-air
        return name; // glm-5, glm-4.7 stay as-is
    };

    RunwayViz.prototype._formatElapsed = function(ms) {
        if (ms < 1000) return ms + 'ms';
        return (ms / 1000).toFixed(1) + 's';
    };

    RunwayViz.prototype._formatTokens = function(n) {
        if (!n) return '0';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    };

    RunwayViz.prototype._updateEmpty = function() {
        if (!this.container) return;
        var isEmpty = this.inFlight.size === 0 && this.completed.length === 0;
        this.container.classList.toggle('empty', isEmpty);
    };

    RunwayViz.prototype._updateFooter = function() {
        if (!this.footerEl) return;
        var parts = [];
        var inflight = this.inFlight.size;
        var completed = this.completed.length;
        if (inflight > 0) parts.push(inflight + ' in-flight');
        if (completed > 0) parts.push(completed + ' completed');
        if (this.requestRate.count > 0) {
            var elapsed = (Date.now() - this.requestRate.windowStart) / 1000;
            if (elapsed > 5) {
                var rpm = Math.round((this.requestRate.count / elapsed) * 60);
                if (rpm > 0) parts.push(rpm + ' req/min');
            }
        }
        if (this._probeActive && this._probeProgress) {
            parts.push('probing ' + this._probeProgress);
        }
        this.footerEl.textContent = parts.join(' \u00B7 ');
    };

    RunwayViz.prototype._setStatus = function(status) {
        if (!this.statusEl) return;
        this.statusEl.className = 'live-flow-status ' + status;
        var labels = { connected: 'Live', polling: 'Polling', error: 'Disconnected' };
        this.statusEl.textContent = labels[status] || status;
    };

    RunwayViz.prototype._onVisibilityChange = function() {
        // Pause/resume progress timer
        if (document.hidden) {
            this._stopProgressTimer();
        } else if (this.enabled) {
            this._startProgressTimer();
        }
    };

    RunwayViz.prototype._onScroll = function() {
        if (!this.streamEl) return;
        var el = this.streamEl;
        var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        this._autoScroll = atBottom;
        if (this.jumpEl) {
            this.jumpEl.style.display = atBottom ? 'none' : '';
        }
    };

    RunwayViz.prototype._scrollToBottom = function() {
        if (!this.streamEl) return;
        this.streamEl.scrollTop = this.streamEl.scrollHeight;
    };

    // -- Fallback Polling --

    RunwayViz.prototype._startFallbackPolling = function() {
        if (this._pollTimer) return;
        this._usePolling = true;
        this._setStatus('polling');
        var self = this;
        this._pollTimer = setInterval(async function() {
            if (!self.enabled) return;
            try {
                var res = await authFetch('/model-routing/pools');
                if (res.ok) {
                    var pools = await res.json();
                    if (typeof window.modelRoutingData !== 'undefined' && window.modelRoutingData) {
                        window.modelRoutingData.pools = pools;
                        if (typeof renderPoolStatus === 'function') {
                            renderPoolStatus(window.modelRoutingData);
                        }
                    }
                }
            } catch (_e) { /* ignore */ }
        }, 3000);
    };

    RunwayViz.prototype._stopFallbackPolling = function() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        this._usePolling = false;
    };

    // -- Cleanup --

    RunwayViz.prototype.destroy = function() {
        this._detachSSE();
        this._stopFallbackPolling();
        this._stopProgressTimer();
        document.removeEventListener('visibilitychange', this._visHandler);
        this._motionQuery.removeEventListener('change', this._motionHandler);
        if (this._compactDebounce) { clearTimeout(this._compactDebounce); this._compactDebounce = null; }
        // Clear expiry timers
        this.completed.forEach(function(row) {
            if (row.expiryTimer) clearTimeout(row.expiryTimer);
        });
        this.inFlight.clear();
        this.completed = [];
        if (this.rowsEl) this.rowsEl.innerHTML = '';
        if (this.streamEl) this.streamEl.removeEventListener('scroll', this._scrollHandler);
        window._liveFlowViz = null;
    };

    // -- SSE Reconnection --

    RunwayViz.prototype.handleSSEReconnect = function() {
        // Clear stale in-flight rows on SSE reconnect
        this.inFlight.clear();
        this._sseAttached = false;
        this._stopFallbackPolling();
        this._attachSSE();
        this._renderStream();
        this._updateEmpty();
    };

    function updateFlowDiagram(routingEnabled) {
        if (!window._liveFlowViz) {
            window._liveFlowViz = new RunwayViz();
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
            var tierPipClass = tier === 'heavy' ? 'pip-heavy' : (tier === 'light' ? 'pip-light' : 'pip-medium');

            var modelsHtml = models.map(function(m) {
                var pct = m.maxConcurrency > 0 ? Math.round((m.inFlight / m.maxConcurrency) * 100) : 0;
                var barClass = m.cooldownMs > 0 ? 'pool-bar-cooled' : (pct >= 80 ? 'pool-bar-high' : (pct >= 50 ? 'pool-bar-medium' : 'pool-bar-low'));
                var displayName = getModelInfo(m.model);
                var valueText = m.inFlight + '/' + m.maxConcurrency;

                // Segmented slot dots (use dots for <=20 slots, bar for larger pools)
                var slotsHtml = '';
                if (m.maxConcurrency > 0 && m.maxConcurrency <= 20) {
                    var maxDots = m.maxConcurrency;
                    var dots = [];
                    for (var d = 0; d < maxDots; d++) {
                        var dotClass = d < m.inFlight ? 'pool-dot active' : 'pool-dot';
                        if (m.cooldownMs > 0) dotClass = 'pool-dot cooled';
                        dots.push('<span class="' + dotClass + '"></span>');
                    }
                    slotsHtml = '<div class="pool-slot-dots">' + dots.join('') + '</div>';
                } else {
                    // Too many slots for dots, show bar
                    var showInline = pct >= 25;
                    slotsHtml = '<div class="pool-bar-track">' +
                        '<div class="pool-bar-fill ' + barClass + '" style="width: ' + pct + '%;">' +
                            (showInline ? '<span class="pool-bar-text">' + valueText + '</span>' : '') +
                        '</div>' +
                        (!showInline ? '<span class="pool-bar-outer">' + valueText + '</span>' : '') +
                    '</div>';
                }

                return '<div class="pool-model-row" role="listitem" aria-label="' + escapeHtml(displayName) + ': ' + escapeHtml(valueText) + ' slots' + (m.cooldownMs > 0 ? ', cooled ' + Math.ceil(m.cooldownMs / 1000) + 's' : '') + '">' +
                    '<span class="pool-model-name">' + escapeHtml(displayName) + '</span>' +
                    '<span class="pool-model-count">' + escapeHtml(valueText) + '</span>' +
                    slotsHtml +
                    (m.cooldownMs > 0 ? '<span class="pool-model-cooldown" title="Cooled down">' + Math.ceil(m.cooldownMs / 1000) + 's</span>' : '') +
                    '</div>';
            }).join('');

            return '<div class="pool-tier-group" role="group" aria-label="' + escapeHtml(tier) + ' tier" data-tier="' + escapeHtml(tier) + '">' +
                '<div class="pool-tier-header">' +
                    '<span class="pool-tier-pip ' + tierPipClass + '"></span>' +
                    '<span class="pool-tier-name">' + escapeHtml(tier) + '</span>' +
                    '<span class="pool-tier-slots">' + totalInFlight + '/' + totalSlots + ' slots</span>' +
                    '<span class="pool-tier-util">' + utilPct + '%</span>' +
                '</div>' +
                modelsHtml +
            '</div>';
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
                var res = await authFetch('/model-routing/pools');
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
        RunwayViz: RunwayViz,
        LiveFlowViz: RunwayViz,  // backward compat alias
        updateFlowDiagram: updateFlowDiagram,
        renderFallbackChains: renderFallbackChains,
        renderPoolStatus: renderPoolStatus,
        startPoolPolling: startPoolPolling,
        stopPoolPolling: stopPoolPolling,
        renderRoutingCooldowns: renderRoutingCooldowns,
        renderRoutingOverrides: renderRoutingOverrides
    };

})(window);
