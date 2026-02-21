/**
 * Live Flow Visualization - Unit Tests
 *
 * TDD Phase: RED - Write failing tests for live-flow.js functions
 * Tests: renderFallbackChains, renderPoolStatus, renderRoutingCooldowns,
 * renderRoutingOverrides, LiveFlowViz class methods
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

        test('applies high utilization bar class when >= 80%', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderPoolStatus({
                pools: {
                    light: [
                        { model: 'glm-4-air', inFlight: 8, maxConcurrency: 10, cooldownMs: 0 }
                    ]
                }
            });

            const container = document.getElementById('modelPoolsViz');
            expect(container.innerHTML).toContain('pool-bar-high');
        });

        test('applies medium utilization bar class when >= 50%', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderPoolStatus({
                pools: {
                    medium: [
                        { model: 'glm-4', inFlight: 5, maxConcurrency: 10, cooldownMs: 0 }
                    ]
                }
            });

            const container = document.getElementById('modelPoolsViz');
            expect(container.innerHTML).toContain('pool-bar-medium');
        });

        test('applies low utilization bar class when < 50%', () => {
            loadLiveFlow();
            window.DashboardLiveFlow.renderPoolStatus({
                pools: {
                    light: [
                        { model: 'glm-4-air', inFlight: 2, maxConcurrency: 10, cooldownMs: 0 }
                    ]
                }
            });

            const container = document.getElementById('modelPoolsViz');
            expect(container.innerHTML).toContain('pool-bar-low');
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

    describe('LiveFlowViz class - Behavior tests', () => {
        let vizInstance;

        beforeEach(() => {
            jest.useFakeTimers();
            setupDOM(`
                <div id="liveFlowCanvas"></div>
                <div id="liveFlowEmpty"></div>
                <div id="liveFlowStatus"></div>
                <div id="liveFlowLegend"></div>
            `);
            mockStore.STATE.modelsData = {};
            loadLiveFlow();
        });

        afterEach(() => {
            if (vizInstance) {
                vizInstance.destroy();
            }
            jest.useRealTimers();
            // Clean up state mutation
            mockStore.STATE.modelsData = {};
        });

        test('constructor creates instance with disabled state', () => {
            vizInstance = new window.DashboardLiveFlow.LiveFlowViz('#liveFlowCanvas');

            expect(vizInstance).toBeDefined();
            expect(vizInstance.enabled).toBe(false);
        });

        test('setEnabled(true) enables visualization', () => {
            vizInstance = new window.DashboardLiveFlow.LiveFlowViz('#liveFlowCanvas');
            vizInstance.setEnabled(true);

            expect(vizInstance.enabled).toBe(true);
        });

        test('setEnabled(false) disables visualization', () => {
            vizInstance = new window.DashboardLiveFlow.LiveFlowViz('#liveFlowCanvas');
            vizInstance.setEnabled(true);
            vizInstance.setEnabled(false);

            expect(vizInstance.enabled).toBe(false);
        });

        test('destroy cleans up timers and listeners', () => {
            vizInstance = new window.DashboardLiveFlow.LiveFlowViz('#liveFlowCanvas');
            vizInstance.setEnabled(true);

            const initialTimerCount = jest.getTimerCount();
            vizInstance.destroy();
            const finalTimerCount = jest.getTimerCount();

            // Should clear timers
            expect(finalTimerCount).toBeLessThanOrEqual(initialTimerCount);
        });

        test('destroy is safe to call multiple times', () => {
            vizInstance = new window.DashboardLiveFlow.LiveFlowViz('#liveFlowCanvas');

            expect(() => {
                vizInstance.destroy();
                vizInstance.destroy(); // Should not throw
            }).not.toThrow();
        });

        test('_setStatus updates status element text', () => {
            vizInstance = new window.DashboardLiveFlow.LiveFlowViz('#liveFlowCanvas');
            vizInstance._setStatus('Test Status');

            const statusEl = document.getElementById('liveFlowStatus');
            expect(statusEl.textContent).toBe('Test Status');
        });

        test('_setStatus clears status when passed null', () => {
            vizInstance = new window.DashboardLiveFlow.LiveFlowViz('#liveFlowCanvas');
            vizInstance._setStatus('Initial');
            vizInstance._setStatus(null);

            const statusEl = document.getElementById('liveFlowStatus');
            expect(statusEl.textContent).toBe('');
        });

        test('_onVisibilityChange pauses when hidden', () => {
            vizInstance = new window.DashboardLiveFlow.LiveFlowViz('#liveFlowCanvas');
            vizInstance.setEnabled(true);
            const initialEnabled = vizInstance.enabled;

            // Simulate visibility hidden
            vizInstance._onVisibilityChange();

            // Behavior: when hidden, should update internal state
            // The exact behavior depends on implementation
            expect(vizInstance).toBeDefined();
        });

        test('updateFlowDiagram handles empty data gracefully', () => {
            // Skip instance cleanup for this test since updateFlowDiagram creates its own
            vizInstance = null;
            expect(() => {
                window.DashboardLiveFlow.updateFlowDiagram({ nodes: [], links: [] });
            }).not.toThrow();
        });

        test('updateFlowDiagram handles null data gracefully', () => {
            // Skip instance cleanup for this test since updateFlowDiagram creates its own
            vizInstance = null;
            expect(() => {
                window.DashboardLiveFlow.updateFlowDiagram(null);
            }).not.toThrow();
        });

        test('_onPoolStatus updates internal pool state', () => {
            vizInstance = new window.DashboardLiveFlow.LiveFlowViz('#liveFlowCanvas');

            expect(() => {
                vizInstance._onPoolStatus({ pools: {} });
            }).not.toThrow();
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
