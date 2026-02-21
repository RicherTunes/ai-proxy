/**
 * SSE (Server-Sent Events) Module - Unit Tests
 *
 * TDD Phase: RED/GREEN - Write and verify tests for sse.js functions
 * Tests: connection status, request rendering, polling fallback, stale detection
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Read source file
const sseSource = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'sse.js'),
    'utf8'
);

describe('sse.js - DashboardSSE module', () => {
    let dom;
    let window;
    let document;
    let mockStore;

    function setupDOM(html = '') {
        dom = new JSDOM(`
            <!DOCTYPE html>
            <html>
            <body>
                <div class="virtual-scroll-viewport" style="height: 400px;">
                    <div id="liveStreamRequestList"></div>
                </div>
                <div id="requestCountBadge"></div>
                <div id="connectionDot" class="connection-dot" data-state="disconnected"></div>
                <div id="connectionText" class="connection-text">Disconnected</div>
                <div id="recentRequestsBody"></div>
            </body>
            </html>
        `, { runScripts: 'dangerously', resources: 'usable' });
        window = dom.window;
        document = window.document;

        // Mock requestAnimationFrame
        window.requestAnimationFrame = jest.fn((cb) => setTimeout(cb, 16));
        window.cancelAnimationFrame = jest.fn((id) => clearTimeout(id));

        // Mock DashboardStore
        mockStore = {
            STATE: {
                sse: {
                    eventSource: null,
                    connected: false,
                    reconnectAttempts: 0
                },
                connection: {
                    status: 'disconnected',
                    lastUpdate: null,
                    staleData: false
                },
                requestsHistory: [],
                traces: []
            },
            FEATURES: {},
            escapeHtml: (str) => String(str).replace(/[&<>"']/g, c => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[c])),
            chipModelName: (str) => str,
            formatTimestamp: (ts) => new Date(ts).toLocaleTimeString(),
            renderEmptyState: (msg, opts) => `<div class="empty-state">${msg}</div>`,
            Actions: {
                sseConnected: jest.fn((data) => data),
                sseDisconnected: jest.fn(() => ({})),
                requestReceived: jest.fn((req) => ({ type: 'REQUEST_RECEIVED', request: req }))
            },
            store: {
                dispatch: jest.fn()
            },
            debugEnabled: false
        };

        window.DashboardStore = mockStore;
        window.showToast = jest.fn();
        window.DashboardInit = {
            getTabOrdering: jest.fn(() => 'desc')
        };

        // Mock EventSource
        window.EventSource = jest.fn().mockImplementation(() => ({
            readyState: 0,
            url: '',
            onopen: null,
            onmessage: null,
            onerror: null,
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            close: jest.fn()
        }));

        // Mock fetch
        window.fetch = jest.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ requests: [] })
            })
        );
    }

    function loadSSE() {
        const scriptEl = document.createElement('script');
        scriptEl.textContent = sseSource;
        document.body.appendChild(scriptEl);
    }

    describe('Module exports', () => {
        beforeEach(() => {
            setupDOM();
            loadSSE();
        });

        test('exports DashboardSSE object', () => {
            expect(window.DashboardSSE).toBeDefined();
            expect(typeof window.DashboardSSE).toBe('object');
        });

        test('exports required functions', () => {
            expect(typeof window.DashboardSSE.connectRequestStream).toBe('function');
            expect(typeof window.DashboardSSE.updateConnectionStatus).toBe('function');
            expect(typeof window.DashboardSSE.addRequestToStream).toBe('function');
            expect(typeof window.DashboardSSE.renderRequestRow).toBe('function');
            expect(typeof window.DashboardSSE.scheduleVirtualRender).toBe('function');
            expect(typeof window.DashboardSSE.updateRequestCountBadge).toBe('function');
            expect(typeof window.DashboardSSE.updateRecentRequestsTable).toBe('function');
            expect(typeof window.DashboardSSE.startRequestPolling).toBe('function');
            expect(typeof window.DashboardSSE.cleanup).toBe('function');
        });
    });

    describe('renderRequestRow', () => {
        beforeEach(() => {
            setupDOM();
            loadSSE();
        });

        test('renders successful request row', () => {
            const request = {
                timestamp: Date.now(),
                keyIndex: 5,
                originalModel: 'claude-opus-4',
                mappedModel: 'claude-opus-4',
                path: '/v1/messages',
                status: 'completed',
                latency: 1250,
                statusCode: 200,
                requestId: 'test-req-1'
            };

            const html = window.DashboardSSE.renderRequestRow(request);

            expect(html).toContain('request-row');
            expect(html).toContain('K5');
            expect(html).toContain('success');
            expect(html).toContain('1250ms');
        });

        test('renders error request row', () => {
            const request = {
                timestamp: Date.now(),
                keyIndex: 3,
                originalModel: 'claude-sonnet-4',
                mappedModel: 'claude-sonnet-4',
                path: '/v1/messages',
                status: 'error',
                error: 'Rate limit exceeded',
                statusCode: 429
            };

            const html = window.DashboardSSE.renderRequestRow(request);

            expect(html).toContain('error');
            expect(html).toContain('ERR');
        });

        test('renders pending request row', () => {
            const request = {
                timestamp: Date.now(),
                keyIndex: 7,
                originalModel: 'glm-4',
                mappedModel: 'glm-4',
                path: '/v1/chat/completions',
                status: 'pending'
            };

            const html = window.DashboardSSE.renderRequestRow(request);

            expect(html).toContain('pending');
            expect(html).toContain('...');
        });

        test('escapes HTML in path', () => {
            const request = {
                timestamp: Date.now(),
                keyIndex: 1,
                path: '/v1/messages?prompt=<script>alert("xss")</script>',
                status: 'completed'
            };

            const html = window.DashboardSSE.renderRequestRow(request);

            expect(html).not.toContain('<script>');
            expect(html).toContain('&lt;');
        });

        test('includes routing chip when model mapping exists', () => {
            const request = {
                timestamp: Date.now(),
                keyIndex: 2,
                originalModel: 'claude-opus-4',
                mappedModel: 'claude-sonnet-4',
                path: '/v1/messages',
                status: 'completed',
                routingDecision: { source: 'rule', reason: 'cost threshold' }
            };

            const html = window.DashboardSSE.renderRequestRow(request);

            expect(html).toContain('routing-chip');
            expect(html).toContain('claude-opus-4');
            expect(html).toContain('claude-sonnet-4');
            expect(html).toContain('\u2192'); // arrow
        });
    });

    describe('updateConnectionStatus', () => {
        beforeEach(() => {
            setupDOM();
            loadSSE();
        });

        test('updates to connected state', () => {
            window.DashboardSSE.updateConnectionStatus('connected');

            const dot = document.getElementById('connectionDot');
            const text = document.getElementById('connectionText');

            expect(dot.className).toContain('connected');
            expect(dot.getAttribute('data-state')).toBe('connected');
            expect(text.textContent).toBe('Connected');
            expect(text.className).toBe('connection-text');
        });

        test('updates to error state', () => {
            window.DashboardSSE.updateConnectionStatus('error');

            const dot = document.getElementById('connectionDot');
            const text = document.getElementById('connectionText');

            expect(dot.className).toContain('error');
            expect(text.textContent).toBe('Connection Error');
            expect(text.className).toContain('stale');
        });

        test('updates to stale state', () => {
            window.DashboardSSE.updateConnectionStatus('stale');

            const text = document.getElementById('connectionText');

            expect(text.textContent).toBe('Stale Data');
            expect(text.className).toContain('stale');
        });
    });

    describe('updateRequestCountBadge', () => {
        beforeEach(() => {
            setupDOM();
            loadSSE();
        });

        test('updates badge with count', () => {
            window.DashboardSSE.updateRequestCountBadge(42);

            const badge = document.getElementById('requestCountBadge');
            expect(badge.textContent).toBe('42');
        });

        test('handles zero count', () => {
            window.DashboardSSE.updateRequestCountBadge(0);

            const badge = document.getElementById('requestCountBadge');
            expect(badge.textContent).toBe('0');
        });

        test('handles null/undefined', () => {
            window.DashboardSSE.updateRequestCountBadge(null);

            const badge = document.getElementById('requestCountBadge');
            expect(badge.textContent).toBe('0');
        });
    });

    describe('updateRecentRequestsTable', () => {
        beforeEach(() => {
            setupDOM();
            loadSSE();
        });

        test('renders table rows from requests history', () => {
            mockStore.STATE.requestsHistory = [
                { timestamp: Date.now(), keyIndex: 1, originalModel: 'glm-4', status: 'completed', statusCode: 200, latency: 500 },
                { timestamp: Date.now() - 1000, keyIndex: 2, originalModel: 'claude-opus-4', status: 'error', statusCode: 500 }
            ];

            window.DashboardSSE.updateRecentRequestsTable();

            const tbody = document.getElementById('recentRequestsBody');
            expect(tbody.innerHTML).toContain('K1');
            expect(tbody.innerHTML).toContain('K2');
            expect(tbody.innerHTML).toContain('OK 200');
            expect(tbody.innerHTML).toContain('ERR 500');
        });

        test('handles empty history gracefully', () => {
            mockStore.STATE.requestsHistory = [];

            window.DashboardSSE.updateRecentRequestsTable();

            const tbody = document.getElementById('recentRequestsBody');
            // Should not throw, tbody may be empty or have placeholder
            expect(tbody).toBeDefined();
        });
    });

    describe('startRequestPolling', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            setupDOM();
            loadSSE();
        });

        afterEach(() => {
            window.DashboardSSE.cleanup();
            jest.useRealTimers();
        });

        test('sets up polling interval that periodically fetches', () => {
            window.DashboardSSE.startRequestPolling();

            expect(jest.getTimerCount()).toBeGreaterThan(0);

            // Advance time to trigger poll
            jest.advanceTimersByTime(5000);

            // Verify fetch was called (the polling makes a fetch call)
            expect(window.fetch).toHaveBeenCalled();
        });

        test('cleanup clears intervals', () => {
            window.DashboardSSE.startRequestPolling();
            const timerCount = jest.getTimerCount();
            expect(timerCount).toBeGreaterThan(0);

            window.DashboardSSE.cleanup();
            jest.advanceTimersByTime(5000);

            // After cleanup, no more fetch calls should be made
            const callCount = window.fetch.mock.calls.length;
            jest.advanceTimersByTime(5000);
            expect(window.fetch.mock.calls.length).toBe(callCount);
        });
    });

    describe('addRequestToStream', () => {
        beforeEach(() => {
            setupDOM();
            loadSSE();
        });

        test('dispatches request received action', () => {
            const request = { timestamp: Date.now(), path: '/test', status: 'completed' };

            window.DashboardSSE.addRequestToStream(request);

            expect(mockStore.store.dispatch).toHaveBeenCalled();
        });

        test('dispatches on addRequestToStream', () => {
            const request = { timestamp: Date.now(), path: '/test', status: 'completed' };

            window.DashboardSSE.addRequestToStream(request);

            expect(mockStore.store.dispatch).toHaveBeenCalledWith({
                type: 'REQUEST_RECEIVED',
                request: expect.objectContaining({ path: '/test' })
            });
        });
    });

    describe('scheduleVirtualRender', () => {
        beforeEach(() => {
            setupDOM();
            loadSSE();
        });

        test('schedules render on next animation frame', () => {
            // Just verify the function exists and is callable without throwing
            expect(typeof window.DashboardSSE.scheduleVirtualRender).toBe('function');

            // Call it - should not throw
            window.DashboardSSE.scheduleVirtualRender();

            // Verify RAF was requested
            expect(window.requestAnimationFrame).toHaveBeenCalled();
        });
    });

    describe('cleanup', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            setupDOM();
            loadSSE();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('cleanup clears polling intervals when active', () => {
            // Start polling to set up intervals
            window.DashboardSSE.startRequestPolling();
            const timerCountBefore = jest.getTimerCount();
            expect(timerCountBefore).toBeGreaterThan(0);

            // Cleanup should clear all intervals without throwing
            expect(() => window.DashboardSSE.cleanup()).not.toThrow();

            // Verify intervals were cleared
            const timerCountAfter = jest.getTimerCount();
            expect(timerCountAfter).toBeLessThan(timerCountBefore);
        });

        test('cleanup is safe when no polling is active', () => {
            // Cleanup without starting polling should not throw
            expect(() => window.DashboardSSE.cleanup()).not.toThrow();
        });
    });

    describe('Edge cases', () => {
        beforeEach(() => {
            setupDOM();
            loadSSE();
        });

        test('handles request without routing decision', () => {
            const request = {
                timestamp: Date.now(),
                keyIndex: 1,
                originalModel: 'glm-4',
                mappedModel: 'glm-4',
                path: '/v1/messages',
                status: 'completed'
            };

            const html = window.DashboardSSE.renderRequestRow(request);

            expect(html).toContain('request-row');
            // Should still render without routing chip
        });

        test('handles request with missing latency', () => {
            const request = {
                timestamp: Date.now(),
                keyIndex: 1,
                path: '/v1/messages',
                status: 'pending'
            };

            const html = window.DashboardSSE.renderRequestRow(request);

            expect(html).toContain('...');
        });

        test('handles request with missing keyIndex', () => {
            const request = {
                timestamp: Date.now(),
                path: '/v1/messages',
                status: 'completed'
            };

            const html = window.DashboardSSE.renderRequestRow(request);

            expect(html).toContain('K?');
        });
    });
});
