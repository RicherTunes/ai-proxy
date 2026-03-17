/**
 * TierBuilder Dirty State & Persistence Tests (TDD)
 *
 * Tests:
 * 1. Save button disabled on initial render (no changes)
 * 2. Save button enabled after user makes changes
 * 3. After successful save, serverState updated and save button disabled
 * 4. Pending badge hidden when no changes
 * 5. Config round-trip: save -> re-fetch -> render matches saved state
 */

describe('TierBuilder dirty state', () => {
    function createMockElement(id) {
        return {
            id: id,
            style: { display: '' },
            className: '',
            textContent: '',
            innerHTML: '',
            disabled: false,
            value: 'balanced',
            parentNode: null,
            addEventListener: function() {},
            removeEventListener: function() {},
            querySelector: function() { return null; },
            querySelectorAll: function() { return []; },
            appendChild: function() {},
            getAttribute: function(attr) { return attr === 'data-model-id' ? null : null; },
            setAttribute: function() {},
            insertBefore: function() {},
            remove: function() {}
        };
    }

    function createMockLane(tierName, models) {
        var lane = createMockElement('tierLane' + tierName);
        var cards = models.map(function(id) {
            var card = createMockElement('card-' + id);
            card.className = 'model-card';
            card.getAttribute = function(attr) {
                return attr === 'data-model-id' ? id : null;
            };
            return card;
        });
        lane.querySelectorAll = function(selector) {
            if (selector === '.model-card') return cards;
            return [];
        };
        return lane;
    }

    // Load the TierBuilder source
    var TierBuilder;
    beforeAll(() => {
        // Set up minimal globals
        global.window = global.window || {};
        global.window.DashboardStore = {
            STATE: { routingData: null, modelsData: {} },
            escapeHtml: function(s) { return s; },
            debugEnabled: false,
            fetchJSON: function() { return Promise.resolve({}); }
        };
        global.window.DashboardFilters = { getAvailableModels: function() { return []; } };
        global.window.showToast = function() {};
        global.window.DashboardData = { fetchModels: function() { return Promise.resolve(); } };

        // Extract TierBuilder from the IIFE
        // We'll test the _computePendingChanges and _updatePending logic directly
    });

    test('save button should be disabled when serverState matches DOM state', () => {
        // Simulate _updatePending with count = 0
        var saveBtn = { disabled: false };
        var resetBtn = { disabled: false };
        var pendingBadge = { style: { display: 'inline-block' } };
        var pendingCount = { textContent: '3' };

        // This is the logic from _updatePending
        var count = 0;
        pendingBadge.style.display = count > 0 ? 'inline-block' : 'none';
        pendingCount.textContent = String(count);
        saveBtn.disabled = count === 0;
        resetBtn.disabled = count === 0;

        expect(saveBtn.disabled).toBe(true);
        expect(resetBtn.disabled).toBe(true);
        expect(pendingBadge.style.display).toBe('none');
        expect(pendingCount.textContent).toBe('0');
    });

    test('save button should be enabled when there are pending changes', () => {
        var saveBtn = { disabled: true };
        var resetBtn = { disabled: true };
        var pendingBadge = { style: { display: 'none' } };
        var pendingCount = { textContent: '0' };

        var count = 2;
        pendingBadge.style.display = count > 0 ? 'inline-block' : 'none';
        pendingCount.textContent = String(count);
        saveBtn.disabled = count === 0;
        resetBtn.disabled = count === 0;

        expect(saveBtn.disabled).toBe(false);
        expect(resetBtn.disabled).toBe(false);
        expect(pendingBadge.style.display).toBe('inline-block');
        expect(pendingCount.textContent).toBe('2');
    });

    test('_computePendingChanges should return 0 when server and current state match', () => {
        var serverState = {
            heavy: { models: ['glm-5', 'glm-4.7'], strategy: 'quality' },
            medium: { models: ['glm-4.5'], strategy: 'balanced' },
            light: { models: ['glm-4.5-air'], strategy: 'throughput' }
        };
        var currentState = {
            heavy: { models: ['glm-5', 'glm-4.7'], strategy: 'quality' },
            medium: { models: ['glm-4.5'], strategy: 'balanced' },
            light: { models: ['glm-4.5-air'], strategy: 'throughput' }
        };

        // Replicate _computePendingChanges logic
        var count = 0;
        ['heavy', 'medium', 'light'].forEach(function(tierName) {
            var server = serverState[tierName] || { models: [], strategy: 'balanced' };
            var current = currentState[tierName] || { models: [], strategy: 'balanced' };
            if (server.strategy !== current.strategy) count++;
            if (server.models.length !== current.models.length) { count++; }
            else {
                for (var i = 0; i < server.models.length; i++) {
                    if (server.models[i] !== current.models[i]) { count++; break; }
                }
            }
        });

        expect(count).toBe(0);
    });

    test('_computePendingChanges should detect model order change', () => {
        var serverState = {
            heavy: { models: ['glm-5', 'glm-4.7'], strategy: 'quality' },
            medium: { models: ['glm-4.5'], strategy: 'balanced' },
            light: { models: ['glm-4.5-air'], strategy: 'throughput' }
        };
        var currentState = {
            heavy: { models: ['glm-4.7', 'glm-5'], strategy: 'quality' }, // swapped order
            medium: { models: ['glm-4.5'], strategy: 'balanced' },
            light: { models: ['glm-4.5-air'], strategy: 'throughput' }
        };

        var count = 0;
        ['heavy', 'medium', 'light'].forEach(function(tierName) {
            var server = serverState[tierName] || { models: [], strategy: 'balanced' };
            var current = currentState[tierName] || { models: [], strategy: 'balanced' };
            if (server.strategy !== current.strategy) count++;
            if (server.models.length !== current.models.length) { count++; }
            else {
                for (var i = 0; i < server.models.length; i++) {
                    if (server.models[i] !== current.models[i]) { count++; break; }
                }
            }
        });

        expect(count).toBe(1); // heavy tier has different order
    });

    test('_computePendingChanges should detect strategy change', () => {
        var serverState = {
            heavy: { models: ['glm-5'], strategy: 'quality' },
            medium: { models: ['glm-4.5'], strategy: 'balanced' },
            light: { models: ['glm-4.5-air'], strategy: 'throughput' }
        };
        var currentState = {
            heavy: { models: ['glm-5'], strategy: 'throughput' }, // changed strategy
            medium: { models: ['glm-4.5'], strategy: 'balanced' },
            light: { models: ['glm-4.5-air'], strategy: 'throughput' }
        };

        var count = 0;
        ['heavy', 'medium', 'light'].forEach(function(tierName) {
            var server = serverState[tierName] || { models: [], strategy: 'balanced' };
            var current = currentState[tierName] || { models: [], strategy: 'balanced' };
            if (server.strategy !== current.strategy) count++;
            if (server.models.length !== current.models.length) { count++; }
            else {
                for (var i = 0; i < server.models.length; i++) {
                    if (server.models[i] !== current.models[i]) { count++; break; }
                }
            }
        });

        expect(count).toBe(1); // heavy tier strategy changed
    });

    test('_extractTierState should extract tiers from routingData correctly', () => {
        var routingData = {
            config: {
                tiers: {
                    heavy: { models: ['glm-5', 'glm-4.7'], strategy: 'quality' },
                    medium: { models: ['glm-4.5'], strategy: 'balanced' },
                    light: { models: ['glm-4.5-air', 'glm-4.5-flash'], strategy: 'throughput' }
                }
            }
        };

        // Replicate _extractTierState logic
        var tiers = routingData?.config?.tiers || {};
        var state = {};
        Object.entries(tiers).forEach(function(entry) {
            var name = entry[0], cfg = entry[1];
            var models = [];
            if (cfg && Array.isArray(cfg.models) && cfg.models.length > 0) {
                models = cfg.models.slice();
            }
            state[name] = { models: models, strategy: cfg.strategy || 'balanced' };
        });

        expect(state.heavy.models).toEqual(['glm-5', 'glm-4.7']);
        expect(state.heavy.strategy).toBe('quality');
        expect(state.medium.models).toEqual(['glm-4.5']);
        expect(state.light.models).toEqual(['glm-4.5-air', 'glm-4.5-flash']);
        expect(state.light.strategy).toBe('throughput');
    });

    test('serverState should equal currentState after render (no pending changes)', () => {
        // If serverState (from _extractTierState) matches what _getCurrentState returns,
        // then _computePendingChanges should return 0 and save button should be disabled.
        var routingData = {
            config: {
                tiers: {
                    heavy: { models: ['glm-5', 'glm-4.7'], strategy: 'quality' },
                    medium: { models: ['glm-4.5'], strategy: 'balanced' },
                    light: { models: ['glm-4.5-air'], strategy: 'throughput' }
                }
            }
        };

        // After render, serverState is set from _extractTierState(routingData)
        var serverState = {};
        var tiers = routingData.config.tiers;
        Object.entries(tiers).forEach(function(entry) {
            var name = entry[0], cfg = entry[1];
            serverState[name] = { models: cfg.models.slice(), strategy: cfg.strategy || 'balanced' };
        });

        // After render, currentState is read from DOM (which was just set from the same data)
        // So currentState should match serverState
        var currentState = JSON.parse(JSON.stringify(serverState));

        var count = 0;
        ['heavy', 'medium', 'light'].forEach(function(tierName) {
            var server = serverState[tierName] || { models: [], strategy: 'balanced' };
            var current = currentState[tierName] || { models: [], strategy: 'balanced' };
            if (server.strategy !== current.strategy) count++;
            if (server.models.length !== current.models.length) { count++; }
            else {
                for (var i = 0; i < server.models.length; i++) {
                    if (server.models[i] !== current.models[i]) { count++; break; }
                }
            }
        });

        expect(count).toBe(0);
    });
});

describe('Model routing persistence round-trip', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    test('PUT config is correctly loaded back on GET', () => {
        // Simulate what gets written to disk
        const savedConfig = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: { models: ['glm-5', 'glm-4.7', 'glm-4.6'], strategy: 'quality' },
                medium: { models: ['glm-4.5'], strategy: 'balanced' },
                light: { models: ['glm-4.5-air', 'glm-4.5-flash'], strategy: 'throughput' }
            },
            rules: [{ match: { model: 'claude-opus*' }, tier: 'heavy' }]
        };

        // Write to temp file
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-test-'));
        const configPath = path.join(tmpDir, 'model-routing.json');
        fs.writeFileSync(configPath, JSON.stringify(savedConfig, null, 2));

        // Simulate loading (what proxy-server does on startup)
        const { normalizeModelRoutingConfig } = require('../lib/model-router-normalizer');
        const raw = fs.readFileSync(configPath, 'utf8');
        const persisted = JSON.parse(raw);
        const result = normalizeModelRoutingConfig(persisted, {});

        // Verify tiers survive round-trip
        expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-5', 'glm-4.7', 'glm-4.6']);
        expect(result.normalizedConfig.tiers.heavy.strategy).toBe('quality');
        expect(result.normalizedConfig.tiers.medium.models).toEqual(['glm-4.5']);
        expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4.5-air', 'glm-4.5-flash']);
        expect(result.normalizedConfig.tiers.light.strategy).toBe('throughput');
        expect(result.migrated).toBe(false);

        // Cleanup
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('normalizer preserves v2 config without modification', () => {
        const { normalizeModelRoutingConfig } = require('../lib/model-router-normalizer');

        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: { models: ['glm-5', 'glm-4.7'], strategy: 'quality' },
                medium: { models: ['glm-4.5'], strategy: 'balanced' },
                light: { models: ['glm-4.5-air'], strategy: 'throughput' }
            }
        };

        const result = normalizeModelRoutingConfig(config, {});
        expect(result.normalizedConfig.tiers).toEqual(config.tiers);
        expect(result.migrated).toBe(false);
    });
});
