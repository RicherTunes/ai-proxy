/**
 * Dashboard Module - Smoke Tests
 *
 * Verifies that generateDashboard() produces valid HTML with essential structure.
 * CSS and JS are now served as external static assets from public/.
 * All behavioral/interactive testing is covered by E2E tests.
 */

const fs = require('fs');
const path = require('path');
const { generateDashboard } = require('../lib/dashboard');

describe('Dashboard smoke tests', () => {
    let dashboardHtml;
    let dashboardCss;
    let dashboardJs;

    beforeAll(() => {
        dashboardHtml = generateDashboard();
        dashboardCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.css'), 'utf8');
        dashboardJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
    });

    test('should generate HTML without errors', () => {
        expect(typeof dashboardHtml).toBe('string');
        expect(dashboardHtml.length).toBeGreaterThan(0);
    });

    test('should contain valid DOCTYPE and HTML structure', () => {
        expect(dashboardHtml).toMatch(/^<!DOCTYPE html>/);
        expect(dashboardHtml).toContain('<html');
        expect(dashboardHtml).toContain('<head>');
        expect(dashboardHtml).toContain('<body>');
    });

    test('should contain major section IDs', () => {
        expect(dashboardHtml).toContain('health-ribbon');
        expect(dashboardHtml).toContain('keysHeatmap');
        expect(dashboardHtml).toContain('dashboard-grid');
    });

    test('should include Chart.js', () => {
        expect(dashboardHtml).toContain('chart.js');
    });

    test('should include SSE connection setup', () => {
        expect(dashboardJs).toContain('EventSource');
    });

    test('should contain Model Routing section', () => {
        expect(dashboardHtml).toContain('modelRoutingPanel');
    });

    test('should contain section subtitles', () => {
        expect(dashboardHtml).toContain('Smart routing + failover');
    });

    test('should contain live flow container for D3 visualization', () => {
        expect(dashboardHtml).toContain('liveFlowContainer');
        expect(dashboardHtml).toContain('live-flow-container');
        expect(dashboardHtml).toContain('data-belongs-to="routing"');
    });

    test('should include D3.js script', () => {
        expect(dashboardHtml).toContain('vendor/d3.min.js');
    });

    test('should include SortableJS script', () => {
        expect(dashboardHtml).toContain('vendor/sortable.min.js');
    });

    test('should contain tier builder container', () => {
        expect(dashboardHtml).toContain('tierBuilderContainer');
        expect(dashboardHtml).toContain('tier-builder');
        expect(dashboardHtml).toContain('tier-lane');
    });

    test('should contain tier builder controls (save, reset, pending badge)', () => {
        expect(dashboardHtml).toContain('tierBuilderSave');
        expect(dashboardHtml).toContain('tierBuilderReset');
        expect(dashboardHtml).toContain('tierBuilderPending');
    });

    test('should contain routing tab navigation', () => {
        expect(dashboardHtml).toContain('routing-tab-nav');
        expect(dashboardHtml).toContain('routing-tab-btn');
        expect(dashboardHtml).toContain('data-routing-tab="observability"');
        expect(dashboardHtml).toContain('data-routing-tab="cooldowns"');
        expect(dashboardHtml).toContain('data-routing-tab="overrides"');
        expect(dashboardHtml).toContain('data-routing-tab="advanced"');
    });

    test('should contain routing tab panels', () => {
        expect(dashboardHtml).toContain('data-routing-panel="observability"');
        expect(dashboardHtml).toContain('data-routing-panel="cooldowns"');
        expect(dashboardHtml).toContain('data-routing-panel="overrides"');
        expect(dashboardHtml).toContain('data-routing-panel="advanced"');
    });

    test('should contain explain button in advanced tab', () => {
        expect(dashboardHtml).toContain('explainBtn');
        expect(dashboardHtml).toContain('explainResult');
        expect(dashboardHtml).toContain('Explain Routing Decision');
    });

    test('should contain Learn more link to docs', () => {
        expect(dashboardHtml).toContain('docs/model-routing.md');
        expect(dashboardHtml).toContain('Learn more');
    });

    test('should contain routing observability KPI elements including decisions', () => {
        expect(dashboardHtml).toContain('routingBurstShare');
        expect(dashboardHtml).toContain('routingFailoverShare');
        expect(dashboardHtml).toContain('routing429PerMin');
        expect(dashboardHtml).toContain('routingPoolCooldown');
        expect(dashboardHtml).toContain('routingDecisionsInWindow');
    });

    test('should contain unified Model Selection section', () => {
        expect(dashboardHtml).toContain('model-selection-section');
        expect(dashboardHtml).toContain('Model Selection');
        expect(dashboardHtml).toContain('modelRoutingPanel');
    });

    test('should contain status pill for routing', () => {
        expect(dashboardHtml).toContain('routing-status-pill');
    });

    test('should contain canonical active system status', () => {
        expect(dashboardHtml).toContain('activeSystemStatus');
    });

    test('should have ARIA tablist on page navigation', () => {
        expect(dashboardHtml).toContain('role="tablist"');
        expect(dashboardHtml).toContain('role="tab"');
        expect(dashboardHtml).toContain('aria-selected');
    });

    test('should have prefers-reduced-motion media query', () => {
        expect(dashboardCss).toContain('prefers-reduced-motion');
    });

    test('should have focus-visible styles', () => {
        expect(dashboardCss).toContain('focus-visible');
    });

    test('should reference external CSS and JS assets', () => {
        // Phase 5: CSS split into modular files under /dashboard/css/
        expect(dashboardHtml).toContain('/dashboard/css/');
        // Phase 6: JS split into modular files under /dashboard/js/
        expect(dashboardHtml).toContain('/dashboard/js/store.js');
        expect(dashboardHtml).toContain('/dashboard/js/init.js');
    });

    test('should include cache-busting version parameter', () => {
        const pkg = require('../package.json');
        expect(dashboardHtml).toContain(`?v=${pkg.version}`);
    });

    test('static CSS file should exist and be non-empty', () => {
        expect(dashboardCss.length).toBeGreaterThan(1000);
    });

    test('static JS file should exist and be non-empty', () => {
        expect(dashboardJs.length).toBeGreaterThan(1000);
    });

    test('should not contain inline <style> block', () => {
        expect(dashboardHtml).not.toContain('<style>');
    });

    test('should not contain inline script content (only external src)', () => {
        // The HTML shell should reference external JS, not contain inline JS code
        expect(dashboardHtml).not.toContain('EventSource');
        expect(dashboardHtml).not.toContain('function escapeHtml');
    });

    test('should contain TierBuilder class', () => {
        expect(dashboardJs).toContain('class TierBuilder');
        expect(dashboardJs).toContain('_initSortable');
        expect(dashboardJs).toContain('_detectSharedModels');
    });

    test('should contain TierBuilder pending changes and save logic', () => {
        expect(dashboardJs).toContain('_computePendingChanges');
        expect(dashboardJs).toContain('tierBuilderSave');
        expect(dashboardJs).toContain('tierBuilderReset');
    });

    test('should contain TierBuilder pool status integration', () => {
        expect(dashboardJs).toContain('updatePoolStatus');
        expect(dashboardJs).toContain('model-card-bar-fill');
        expect(dashboardJs).toContain('model-card-cooldown');
    });

    test('should contain SortableJS initialization', () => {
        expect(dashboardJs).toContain('Sortable.create');
        expect(dashboardJs).toContain("group:");
        expect(dashboardJs).toContain("'clone'");
    });

    test('should contain switchRoutingTab function', () => {
        expect(dashboardJs).toContain('function switchRoutingTab');
        expect(dashboardJs).toContain('routing-tab-btn');
        expect(dashboardJs).toContain('routing-tab-panel');
    });

    test('should contain explain functions', () => {
        expect(dashboardJs).toContain('function runExplain');
        expect(dashboardJs).toContain('function renderExplainResult');
        expect(dashboardJs).toContain('model-routing/explain');
    });
});
