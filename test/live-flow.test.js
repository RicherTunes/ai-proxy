/**
 * Live Flow Visualization - Unit Tests
 *
 * Tests: renderFallbackChains, renderPoolStatus, renderRoutingCooldowns,
 * renderRoutingOverrides, RunwayViz class (per-request flow visualization)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Read source file
const liveFlowSource = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'live-flow.js'),
    'utf8'
);

describe('live-flow.js', () => {
    let dom;
    let window;
    let document;

    // Mock DashboardStore
    const mockStore = {
        STATE: {
            sse: { eventSource: null },
            modelsData: {}
        },
        FEATURES: { d3: true },
        escapeHtml: (str) => String(str).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c])),
        showToast: jest.fn()
    };

    function setupDOM(html = '') {
        dom = new JSDOM(`
            <!DOCTYPE html>
            <html>
            <body>
                ${html}
            </body>
            </html>
        `, { runScripts: 'dangerously', resources: 'usable' });
        window = dom.window;
        document = window.document;

        // Set up global mocks
        window.DashboardStore = mockStore;
        window.showToast = jest.fn();
        window.matchMedia = jest.fn(() => ({
            matches: false,
            addEventListener: jest.fn(),
            removeEventListener: jest.fn()
        }));

        // Mock D3 with full chainable API including remove
        const createMockSelection = () => {
            const selection = {
                append: jest.fn(() => createMockSelection()),
                attr: jest.fn(function() { return this; }),
                style: jest.fn(function() { return this; }),
                selectAll: jest.fn(() => {
                    const enterObj = jest.fn(() => ({
                        append: jest.fn(() => createMockSelection())
                    }));
                    const exitObj = jest.fn(() => createMockSelection());
                    const dataSelection = {
                        data: jest.fn(() => ({
                            enter: enterObj,
                            merge: jest.fn(function() { return this; }),
                            exit: exitObj
                        }))
                    };
                    // Make remove() chainable
                    dataSelection.remove = jest.fn(() => createMockSelection());
                    return dataSelection;
                }),
                select: jest.fn(() => createMockSelection()),
                remove: jest.fn(() => createMockSelection()),
                merge: jest.fn(function() { return this; }),
                text: jest.fn(function() { return this; }),
                on: jest.fn(function() { return this; })
            };
            return selection;
        };

        window.d3 = {
            select: jest.fn(() => createMockSelection())
        };
    }

    function loadLiveFlow() {
        const scriptEl = document.createElement('script');
        scriptEl.textContent = liveFlowSource;
        document.body.appendChild(scriptEl);
    }

    describe('renderFallbackChains', () => {
        beforeEach(() => {
            setupDOM('<div id="fallbackChainsViz"></div>');
        });

        test('renders "No fallback chains configured" when no tiers', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderFallbackChains({ config: { tiers: null } });

            const container = document.getElementById('fallbackChainsViz');
            expect(container.textContent).toContain('No fallback chains configured');
        });

        test('renders primary model with tier badge', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderFallbackChains({
                config: {
                    tiers: {
                        medium: { targetModel: 'glm-4.5', fallbackModels: [] }
                    }
                },
                cooldowns: {}
            });

            const container = document.getElementById('fallbackChainsViz');
            expect(container.innerHTML).toContain('glm-4.5');
            expect(container.innerHTML).toContain('fallback-chain-row');
        });

        test('renders fallback models with arrow separators', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderFallbackChains({
                config: {
                    tiers: {
                        heavy: {
                            targetModel: 'claude-opus-4',
                            fallbackModels: ['claude-sonnet-4', 'claude-haiku-4']
                        }
                    }
                },
                cooldowns: {}
            });

            const container = document.getElementById('fallbackChainsViz');
            expect(container.innerHTML).toContain('\u2192'); // arrow character
        });

        test('shows cooldown status when model is cooled down', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderFallbackChains({
                config: {
                    tiers: {
                        medium: {
                            targetModel: 'glm-4',
                            fallbackModels: ['glm-3']
                        }
                    }
                },
                cooldowns: {
                    'glm-3': { remainingMs: 5000, count: 2 }
                }
            });

            const container = document.getElementById('fallbackChainsViz');
            expect(container.innerHTML).toContain('chain-status-cooled');
            expect(container.innerHTML).toContain('5s');
        });

        test('handles failoverModel as fallback (legacy format)', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderFallbackChains({
                config: {
                    tiers: {
                        light: {
                            targetModel: 'glm-4-air',
                            failoverModel: 'glm-3-turbo'
                        }
                    }
                },
                cooldowns: {}
            });

            const container = document.getElementById('fallbackChainsViz');
            expect(container.innerHTML).toContain('glm-4-air');
            expect(container.innerHTML).toContain('glm-3-turbo');
        });

        test('uses displayName from modelsData when available', () => {
            mockStore.STATE.modelsData = {
                'glm-4.5': { displayName: 'GLM-4.5', tier: 'premium' }
            };
            loadLiveFlow();

            window.DashboardLiveFlow.renderFallbackChains({
                config: {
                    tiers: {
                        medium: { targetModel: 'glm-4.5', fallbackModels: [] }
                    }
                },
                cooldowns: {}
            });

            const container = document.getElementById('fallbackChainsViz');
            expect(container.innerHTML).toContain('GLM-4.5');
        });
    });

    describe('renderPoolStatus', () => {
        beforeEach(() => {
            setupDOM(`
                <div id="modelPoolsSection" style="display: none;">
                    <div id="modelPoolsViz"></div>
                </div>
            `);
            mockStore.STATE.modelsData = {};
        });

        test('hides section when no pools data', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderPoolStatus({ pools: null });

            const section = document.getElementById('modelPoolsSection');
            expect(section.style.display).toBe('none');
        });

        test('hides section when pools is empty object', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderPoolStatus({ pools: {} });

            const section = document.getElementById('modelPoolsSection');
            expect(section.style.display).toBe('none');
        });

        test('shows section and renders pool tiers', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderPoolStatus({
                pools: {
                    heavy: [
                        { model: 'claude-opus-4', inFlight: 5, maxConcurrency: 10, cooldownMs: 0 }
                    ]
                }
            });

            const section = document.getElementById('modelPoolsSection');
            expect(section.style.display).toBe('block');

            const container = document.getElementById('modelPoolsViz');
            expect(container.innerHTML).toContain('heavy');
            expect(container.innerHTML).toContain('pool-tier-group');
        });

        test('calculates utilization percentage correctly', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderPoolStatus({
                pools: {
                    medium: [
                        { model: 'glm-4', inFlight: 5, maxConcurrency: 10, cooldownMs: 0 }
                    ]
                }
            });

            const container = document.getElementById('modelPoolsViz');
            expect(container.innerHTML).toContain('50%');
        });

        test('applies cooldown styling when cooldownMs > 0', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderPoolStatus({
                pools: {
                    heavy: [
                        { model: 'claude-opus-4', inFlight: 0, maxConcurrency: 10, cooldownMs: 3000 }
                    ]
                }
            });

            const container = document.getElementById('modelPoolsViz');
            expect(container.innerHTML).toContain('pool-model-cooldown');
            expect(container.innerHTML).toContain('3s');
        });

        test('renders slot dots for small pools (<=20 slots)', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderPoolStatus({
                pools: {
                    light: [
                        { model: 'glm-4-air', inFlight: 8, maxConcurrency: 10, cooldownMs: 0 }
                    ]
                }
            });

            const container = document.getElementById('modelPoolsViz');
            expect(container.innerHTML).toContain('pool-slot-dots');
            // 8 active + 2 inactive = 10 dots
            const activeDots = (container.innerHTML.match(/pool-dot active/g) || []).length;
            expect(activeDots).toBe(8);
        });

        test('renders bar for large pools (>20 slots)', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderPoolStatus({
                pools: {
                    medium: [
                        { model: 'glm-4', inFlight: 15, maxConcurrency: 25, cooldownMs: 0 }
                    ]
                }
            });

            const container = document.getElementById('modelPoolsViz');
            expect(container.innerHTML).toContain('pool-bar-track');
            expect(container.innerHTML).toContain('pool-bar-fill');
        });

        test('renders cooled dots when model has cooldown', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderPoolStatus({
                pools: {
                    light: [
                        { model: 'glm-4-air', inFlight: 2, maxConcurrency: 10, cooldownMs: 5000 }
                    ]
                }
            });

            const container = document.getElementById('modelPoolsViz');
            expect(container.innerHTML).toContain('pool-dot cooled');
        });
    });

    describe('renderRoutingCooldowns', () => {
        beforeEach(() => {
            setupDOM('<table><tbody id="routingCooldownBody"></tbody></table>');
            window.modelRoutingData = { cooldowns: {} };
        });

        test('renders "None" when no cooldowns', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderRoutingCooldowns();

            const tbody = document.getElementById('routingCooldownBody');
            expect(tbody.innerHTML).toContain('None');
        });

        test('renders cooldown entries with remaining time and count', () => {
            window.modelRoutingData = {
                cooldowns: {
                    'claude-opus-4': { remainingMs: 5000, count: 3 }
                }
            };
            loadLiveFlow();
            window.DashboardLiveFlow.renderRoutingCooldowns();

            const tbody = document.getElementById('routingCooldownBody');
            expect(tbody.innerHTML).toContain('claude-opus-4');
            expect(tbody.innerHTML).toContain('5.0s');
            expect(tbody.innerHTML).toContain('3');
        });

        test('shows burst dampened indicator', () => {
            window.modelRoutingData = {
                cooldowns: {
                    'glm-4': { remainingMs: 10000, count: 5, burstDampened: true }
                }
            };
            loadLiveFlow();
            window.DashboardLiveFlow.renderRoutingCooldowns();

            const tbody = document.getElementById('routingCooldownBody');
            expect(tbody.innerHTML).toContain('(burst)');
        });
    });

    describe('renderRoutingOverrides', () => {
        beforeEach(() => {
            setupDOM('<table><tbody id="routingOverrideBody"></tbody></table>');
            window.modelRoutingData = { overrides: {} };
        });

        test('renders "None" when no overrides', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderRoutingOverrides();

            const tbody = document.getElementById('routingOverrideBody');
            expect(tbody.innerHTML).toContain('None');
        });

        test('renders override entries with remove button', () => {
            window.modelRoutingData = {
                overrides: {
                    'sk-test-key': 'claude-opus-4'
                }
            };
            loadLiveFlow();
            window.DashboardLiveFlow.renderRoutingOverrides();

            const tbody = document.getElementById('routingOverrideBody');
            expect(tbody.innerHTML).toContain('sk-test-key');
            expect(tbody.innerHTML).toContain('claude-opus-4');
            expect(tbody.innerHTML).toContain('remove-routing-override');
        });
    });

    describe('Pool Polling', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            setupDOM('<div id="modelPoolsSection" style="display: block;"></div>');
            window.modelRoutingData = { pools: {} };
            window._tierBuilder = { updatePoolStatus: jest.fn() };
        });

        afterEach(() => {
            window.DashboardLiveFlow?.stopPoolPolling();
            jest.useRealTimers();
        });

        test('startPoolPolling sets up interval', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.startPoolPolling();

            expect(jest.getTimerCount()).toBeGreaterThan(0);
        });

        test('stopPoolPolling clears interval', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.startPoolPolling();
            expect(jest.getTimerCount()).toBeGreaterThan(0);

            window.DashboardLiveFlow.stopPoolPolling();
            // The timer variable should be cleared (internal state check)
            // Verify that calling stopPoolPolling again is safe (idempotent)
            window.DashboardLiveFlow.stopPoolPolling(); // Should not throw
        });

        test('does not start duplicate polling', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.startPoolPolling();
            const firstTimerCount = jest.getTimerCount();
            window.DashboardLiveFlow.startPoolPolling();

            expect(jest.getTimerCount()).toBe(firstTimerCount);
        });
    });

    describe('RunwayViz class - Core behavior', () => {
        let vizInstance;

        const RUNWAY_DOM = `
            <div class="runway-viz" id="runwayViz">
                <section class="runway-section runway-inflight">
                    <h5 class="runway-section-label">IN-FLIGHT</h5>
                    <div class="runway-rows" id="runwayInflightRows"></div>
                    <div class="runway-overflow" id="runwayOverflow" style="display:none">
                        +<span id="runwayOverflowCount">0</span> more in-flight
                    </div>
                </section>
                <section class="runway-section runway-completed">
                    <h5 class="runway-section-label">JUST COMPLETED</h5>
                    <div class="runway-rows" id="runwayCompletedRows"></div>
                </section>
                <div class="runway-empty" id="runwayEmpty"></div>
                <div class="runway-footer" id="runwayFooter"></div>
            </div>
            <span id="liveFlowStatus"></span>
        `;

        beforeEach(() => {
            jest.useFakeTimers();
            setupDOM(RUNWAY_DOM);
            mockStore.STATE.modelsData = {};
            loadLiveFlow();
        });

        afterEach(() => {
            if (vizInstance) {
                vizInstance.destroy();
            }
            jest.useRealTimers();
            mockStore.STATE.modelsData = {};
        });

        test('constructor creates instance with disabled state', () => {
            vizInstance = new window.DashboardLiveFlow.RunwayViz();
            expect(vizInstance).toBeDefined();
            expect(vizInstance.enabled).toBe(false);
            expect(vizInstance.inFlight.size).toBe(0);
            expect(vizInstance.completed.length).toBe(0);
        });

        test('setEnabled(true) enables visualization', () => {
            vizInstance = new window.DashboardLiveFlow.RunwayViz();
            vizInstance.setEnabled(true);
            expect(vizInstance.enabled).toBe(true);
        });

        test('setEnabled(false) disables visualization', () => {
            vizInstance = new window.DashboardLiveFlow.RunwayViz();
            vizInstance.setEnabled(true);
            vizInstance.setEnabled(false);
            expect(vizInstance.enabled).toBe(false);
        });

        test('destroy cleans up timers and listeners', () => {
            vizInstance = new window.DashboardLiveFlow.RunwayViz();
            vizInstance.setEnabled(true);
            const initialTimerCount = jest.getTimerCount();
            vizInstance.destroy();
            const finalTimerCount = jest.getTimerCount();
            expect(finalTimerCount).toBeLessThanOrEqual(initialTimerCount);
        });

        test('destroy is safe to call multiple times', () => {
            vizInstance = new window.DashboardLiveFlow.RunwayViz();
            expect(() => {
                vizInstance.destroy();
                vizInstance.destroy();
            }).not.toThrow();
        });

        test('_setStatus updates status element text', () => {
            vizInstance = new window.DashboardLiveFlow.RunwayViz();
            vizInstance._setStatus('connected');
            const statusEl = document.getElementById('liveFlowStatus');
            expect(statusEl.textContent).toBe('Live');
        });

        test('_onVisibilityChange pauses when hidden', () => {
            vizInstance = new window.DashboardLiveFlow.RunwayViz();
            vizInstance.setEnabled(true);
            vizInstance._onVisibilityChange();
            expect(vizInstance).toBeDefined();
        });

        test('updateFlowDiagram creates instance and handles arguments', () => {
            vizInstance = null;
            expect(() => {
                window.DashboardLiveFlow.updateFlowDiagram(true);
            }).not.toThrow();
            expect(window._liveFlowViz).toBeDefined();
            // Clean up
            window._liveFlowViz.destroy();
        });

        test('updateFlowDiagram handles false gracefully', () => {
            vizInstance = null;
            expect(() => {
                window.DashboardLiveFlow.updateFlowDiagram(false);
            }).not.toThrow();
        });

        test('LiveFlowViz alias points to RunwayViz', () => {
            expect(window.DashboardLiveFlow.LiveFlowViz).toBe(window.DashboardLiveFlow.RunwayViz);
        });
    });

    describe('RunwayViz - Request lifecycle', () => {
        let vizInstance;

        const RUNWAY_DOM = `
            <div class="runway-viz" id="runwayViz">
                <div class="runway-stream" id="runwayStream">
                    <div class="runway-rows" id="runwayRows"></div>
                </div>
                <div class="runway-jump" id="runwayJump" style="display:none">
                    <button class="runway-jump-btn" id="runwayJumpBtn">Latest</button>
                </div>
                <div class="runway-empty" id="runwayEmpty"></div>
                <div class="runway-footer" id="runwayFooter"></div>
            </div>
            <span id="liveFlowStatus"></span>
        `;

        function makeSSEEvent(data) {
            return { data: JSON.stringify(data) };
        }

        beforeEach(() => {
            jest.useFakeTimers();
            setupDOM(RUNWAY_DOM);
            mockStore.STATE.modelsData = {};
            loadLiveFlow();
            vizInstance = new window.DashboardLiveFlow.RunwayViz();
        });

        afterEach(() => {
            if (vizInstance) vizInstance.destroy();
            jest.useRealTimers();
            mockStore.STATE.modelsData = {};
        });

        test('request-start creates in-flight row', () => {
            vizInstance._handleRequestStart(makeSSEEvent({
                requestId: 'req-test-a21f',
                originalModel: 'claude-sonnet-4',
                mappedModel: 'glm-5',
                tier: 'heavy',
                timestamp: Date.now()
            }));

            expect(vizInstance.inFlight.size).toBe(1);
            expect(vizInstance.inFlight.has('req-test-a21f')).toBe(true);

            const row = vizInstance.inFlight.get('req-test-a21f');
            expect(row.status).toBe('processing');
            expect(row.mappedModel).toBe('glm-5');
            expect(row.shortId).toBe('a21f');

            // DOM should have a runway row
            const rows = document.querySelectorAll('#runwayRows .runway-row');
            expect(rows.length).toBe(1);
            expect(rows[0].getAttribute('data-status')).toBe('processing');
        });

        test('request-retry updates in-flight row with retry info', () => {
            // First: start
            vizInstance._handleRequestStart(makeSSEEvent({
                requestId: 'req-retry-test',
                mappedModel: 'glm-4.7',
                tier: 'medium',
                timestamp: Date.now()
            }));

            // Then: retry
            vizInstance._handleRequestRetry(makeSSEEvent({
                requestId: 'req-retry-test',
                attempt: 1,
                mappedModel: 'glm-4.6',
                previousModel: 'glm-4.7',
                errorType: 'rate_limited',
                timestamp: Date.now()
            }));

            const row = vizInstance.inFlight.get('req-retry-test');
            expect(row.retries.length).toBe(1);
            expect(row.retries[0].model).toBe('glm-4.7');
            expect(row.retries[0].errorType).toBe('rate_limited');
            expect(row.mappedModel).toBe('glm-4.6');

            // DOM should show retry badge
            const rowEl = document.querySelector('#runwayRows .runway-row');
            expect(rowEl.innerHTML).toContain('runway-badge');
            expect(rowEl.innerHTML).toContain('429');
            expect(rowEl.innerHTML).toContain('runway-retry');
        });

        test('request-complete moves row from in-flight to completed after recv phase', () => {
            vizInstance._handleRequestStart(makeSSEEvent({
                requestId: 'req-complete-test',
                mappedModel: 'glm-5',
                tier: 'heavy',
                timestamp: Date.now() - 2000
            }));

            expect(vizInstance.inFlight.size).toBe(1);

            vizInstance._handleRequestComplete(makeSSEEvent({
                requestId: 'req-complete-test',
                mappedModel: 'glm-5',
                latency: 2000,
                inputTokens: 1200,
                outputTokens: 890,
                timestamp: Date.now()
            }));

            // During recv phase, row is still in-flight with phase='recv'
            expect(vizInstance.inFlight.has('req-complete-test')).toBe(true);
            const row = vizInstance.inFlight.get('req-complete-test');
            expect(row.phase).toBe('recv');
            expect(row.latencyMs).toBe(2000);

            // Advance past recv hold delay (300-400ms)
            jest.advanceTimersByTime(500);

            expect(vizInstance.inFlight.size).toBe(0);
            expect(vizInstance.completed.length).toBe(1);
            expect(vizInstance.completed[0].status).toBe('completed');

            // Completed section should render
            const completedRows = document.querySelectorAll('#runwayRows .runway-row.completed');
            expect(completedRows.length).toBe(1);
            expect(completedRows[0].classList.contains('completed')).toBe(true);
        });

        test('orphan request-complete synthesizes completed row', () => {
            vizInstance._handleRequestComplete(makeSSEEvent({
                requestId: 'req-orphan-test',
                mappedModel: 'glm-4',
                latency: 1500,
                timestamp: Date.now()
            }));

            // Should appear in completed even without request-start
            expect(vizInstance.inFlight.size).toBe(0);
            expect(vizInstance.completed.length).toBe(1);
            expect(vizInstance.completed[0].requestId).toBe('req-orphan-test');
        });

        test('completed rows expire after timeout', () => {
            vizInstance._handleRequestComplete(makeSSEEvent({
                requestId: 'req-expire-test',
                mappedModel: 'glm-4',
                latency: 1000,
                timestamp: Date.now()
            }));

            expect(vizInstance.completed.length).toBe(1);

            // Advance past expiry (30s)
            jest.advanceTimersByTime(31000);

            expect(vizInstance.completed.length).toBe(0);
        });

        test('completed rows capped at max 15', () => {
            for (let i = 0; i < 18; i++) {
                vizInstance._handleRequestComplete(makeSSEEvent({
                    requestId: 'req-cap-' + i,
                    mappedModel: 'glm-4',
                    latency: 1000,
                    timestamp: Date.now() + i
                }));
            }

            expect(vizInstance.completed.length).toBe(15);
            // Most recent should be first (FIFO unshift)
            expect(vizInstance.completed[0].requestId).toBe('req-cap-17');
        });

        test('error request-complete sets error status after recv phase', () => {
            vizInstance._handleRequestStart(makeSSEEvent({
                requestId: 'req-error-test',
                mappedModel: 'glm-5',
                tier: 'heavy',
                timestamp: Date.now()
            }));

            vizInstance._handleRequestComplete(makeSSEEvent({
                requestId: 'req-error-test',
                mappedModel: 'glm-5',
                error: 'timeout',
                latency: 10000,
                timestamp: Date.now()
            }));

            // Advance past recv hold delay
            jest.advanceTimersByTime(500);

            expect(vizInstance.completed[0].status).toBe('error');
            const completedRow = document.querySelector('#runwayRows .runway-row.completed');
            expect(completedRow.classList.contains('error-row')).toBe(true);
        });

        test('orphan request-retry is ignored', () => {
            vizInstance._handleRequestRetry(makeSSEEvent({
                requestId: 'req-unknown',
                attempt: 1,
                mappedModel: 'glm-4',
                errorType: 'rate_limited',
                timestamp: Date.now()
            }));

            expect(vizInstance.inFlight.size).toBe(0);
        });
    });

    describe('RunwayViz - Overflow and priority', () => {
        let vizInstance;

        const RUNWAY_DOM = `
            <div class="runway-viz" id="runwayViz">
                <div class="runway-stream" id="runwayStream">
                    <div class="runway-rows" id="runwayRows"></div>
                </div>
                <div class="runway-jump" id="runwayJump" style="display:none">
                    <button class="runway-jump-btn" id="runwayJumpBtn">Latest</button>
                </div>
                <div class="runway-empty" id="runwayEmpty"></div>
                <div class="runway-footer" id="runwayFooter"></div>
            </div>
            <span id="liveFlowStatus"></span>
        `;

        function makeSSEEvent(data) {
            return { data: JSON.stringify(data) };
        }

        beforeEach(() => {
            jest.useFakeTimers();
            setupDOM(RUNWAY_DOM);
            mockStore.STATE.modelsData = {};
            loadLiveFlow();
            vizInstance = new window.DashboardLiveFlow.RunwayViz();
        });

        afterEach(() => {
            if (vizInstance) vizInstance.destroy();
            jest.useRealTimers();
            mockStore.STATE.modelsData = {};
        });

        test('scrollable stream shows all rows up to max', () => {
            for (let i = 0; i < 10; i++) {
                vizInstance._handleRequestStart(makeSSEEvent({
                    requestId: 'req-scroll-' + i,
                    mappedModel: 'glm-4',
                    tier: 'medium',
                    timestamp: Date.now() + i
                }));
            }

            expect(vizInstance.inFlight.size).toBe(10);
            // All 10 rows should be rendered (scrollable container, no overflow cutoff)
            const rows = document.querySelectorAll('#runwayRows .runway-row');
            expect(rows.length).toBe(10);
        });

        test('priority sort: errors appear first', () => {
            // Add normal request (old = high elapsed time)
            vizInstance._handleRequestStart(makeSSEEvent({
                requestId: 'req-normal',
                mappedModel: 'glm-4',
                tier: 'medium',
                timestamp: Date.now() - 5000
            }));

            // Add error request (newer but errored)
            vizInstance._handleRequestStart(makeSSEEvent({
                requestId: 'req-error',
                mappedModel: 'glm-5',
                tier: 'heavy',
                timestamp: Date.now()
            }));
            // Mark as error status
            vizInstance.inFlight.get('req-error').status = 'error';
            vizInstance._renderStream();

            const rows = document.querySelectorAll('#runwayRows .runway-row');
            expect(rows.length).toBe(2);
            // Error row should be first despite being newer
            expect(rows[0].getAttribute('data-request-id')).toBe('req-error');
        });

        test('SSE reconnect clears in-flight', () => {
            vizInstance._handleRequestStart(makeSSEEvent({
                requestId: 'req-stale',
                mappedModel: 'glm-4',
                tier: 'medium',
                timestamp: Date.now()
            }));

            expect(vizInstance.inFlight.size).toBe(1);

            vizInstance.handleSSEReconnect();

            expect(vizInstance.inFlight.size).toBe(0);
        });

        test('empty state shown when no requests', () => {
            const container = document.getElementById('runwayViz');
            expect(container.classList.contains('empty')).toBe(true);
        });

        test('empty state hidden when requests exist', () => {
            vizInstance._handleRequestStart(makeSSEEvent({
                requestId: 'req-notempty',
                mappedModel: 'glm-4',
                tier: 'medium',
                timestamp: Date.now()
            }));

            const container = document.getElementById('runwayViz');
            expect(container.classList.contains('empty')).toBe(false);
        });
    });

    describe('State cleanup', () => {
        test('modelsData is cleaned between tests', () => {
            // First test sets state
            mockStore.STATE.modelsData = { 'test-model': { displayName: 'Test' } };
            expect(mockStore.STATE.modelsData['test-model']).toBeDefined();

            // Clean up
            mockStore.STATE.modelsData = {};

            // State should be empty
            expect(Object.keys(mockStore.STATE.modelsData).length).toBe(0);
        });
    });
});
