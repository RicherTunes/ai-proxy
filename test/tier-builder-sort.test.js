/**
 * Tier Builder Sort Tests
 * Tests for sortBank() ordering for each mode + tie-break determinism
 */

describe('TierBuilder.sortBank', () => {
    // Mock TierBuilder with _bankModels and _modelsData
    function createMockBuilder(models, modelsData) {
        var renderedOrder = null;
        return {
            _bankModels: models.slice(),
            _modelsData: modelsData,
            _bankSort: 'name',
            _renderBank: function(sorted) { renderedOrder = sorted.slice(); },
            getRenderedOrder: function() { return renderedOrder; },
            sortBank: function(sortBy) {
                if (!this._bankModels || !this._modelsData) return;
                this._bankSort = sortBy;
                var md = this._modelsData;
                var TIER_ORDER = { HEAVY: 0, MEDIUM: 1, LIGHT: 2, FREE: 3 };

                function getPrice(d) {
                    var p = d && d.pricing;
                    return p ? (p.input || 0) + (p.output || 0) : 0;
                }

                var sorted = this._bankModels.slice().sort(function(a, b) {
                    var da = md[a] || {};
                    var db = md[b] || {};
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

                this._renderBank(sorted, md);
            }
        };
    }

    const MODELS = ['model-c', 'model-a', 'model-b', 'model-d'];
    const MODELS_DATA = {
        'model-a': { displayName: 'Alpha', tier: 'LIGHT', maxConcurrency: 5, pricing: { input: 0.25, output: 1.25 }, supportsVision: false },
        'model-b': { displayName: 'Bravo', tier: 'HEAVY', maxConcurrency: 2, pricing: { input: 15.00, output: 75.00 }, supportsVision: true },
        'model-c': { displayName: 'Charlie', tier: 'MEDIUM', maxConcurrency: 3, pricing: { input: 3.00, output: 15.00 }, supportsVision: true },
        'model-d': { displayName: 'Delta', tier: 'FREE', maxConcurrency: 10, pricing: { input: 0, output: 0 }, supportsVision: false }
    };

    it('sorts by name alphabetically using displayName', () => {
        const builder = createMockBuilder(MODELS, MODELS_DATA);
        builder.sortBank('name');
        const order = builder.getRenderedOrder();
        expect(order).toEqual(['model-a', 'model-b', 'model-c', 'model-d']);
    });

    it('sorts by tier: HEAVY < MEDIUM < LIGHT < FREE', () => {
        const builder = createMockBuilder(MODELS, MODELS_DATA);
        builder.sortBank('tier');
        const order = builder.getRenderedOrder();
        expect(order).toEqual(['model-b', 'model-c', 'model-a', 'model-d']);
    });

    it('sorts by price ascending: free first, then cheapest', () => {
        const builder = createMockBuilder(MODELS, MODELS_DATA);
        builder.sortBank('price-asc');
        const order = builder.getRenderedOrder();
        // Delta=0, Alpha=1.50, Charlie=18.00, Bravo=90.00
        expect(order).toEqual(['model-d', 'model-a', 'model-c', 'model-b']);
    });

    it('sorts by price descending: most expensive first', () => {
        const builder = createMockBuilder(MODELS, MODELS_DATA);
        builder.sortBank('price-desc');
        const order = builder.getRenderedOrder();
        // Bravo=90.00, Charlie=18.00, Alpha=1.50, Delta=0
        expect(order).toEqual(['model-b', 'model-c', 'model-a', 'model-d']);
    });

    it('sorts by concurrency: highest first', () => {
        const builder = createMockBuilder(MODELS, MODELS_DATA);
        builder.sortBank('concurrency');
        const order = builder.getRenderedOrder();
        // Delta=10, Alpha=5, Charlie=3, Bravo=2
        expect(order).toEqual(['model-d', 'model-a', 'model-c', 'model-b']);
    });

    it('handles mixed case tiers: heavy, HEAVY, Heavy all treated same', () => {
        const mixedData = {
            'x': { displayName: 'X', tier: 'heavy', maxConcurrency: 1, pricing: { input: 1, output: 1 } },
            'y': { displayName: 'Y', tier: 'HEAVY', maxConcurrency: 1, pricing: { input: 1, output: 1 } },
            'z': { displayName: 'Z', tier: 'Heavy', maxConcurrency: 1, pricing: { input: 1, output: 1 } }
        };
        const builder = createMockBuilder(['z', 'x', 'y'], mixedData);
        builder.sortBank('tier');
        const order = builder.getRenderedOrder();
        // All HEAVY tier=0, tie-break by displayName: X, Y, Z
        expect(order).toEqual(['x', 'y', 'z']);
    });

    it('models with no pricing sort as free (cost=0)', () => {
        const partialData = {
            'paid': { displayName: 'Paid', tier: 'MEDIUM', pricing: { input: 5, output: 10 } },
            'free': { displayName: 'Free', tier: 'FREE' },
            'nodata': { displayName: 'NoData' }
        };
        const builder = createMockBuilder(['paid', 'free', 'nodata'], partialData);
        builder.sortBank('price-asc');
        const order = builder.getRenderedOrder();
        // Free=0, NoData=0 (tie-break: Free < NoData), Paid=15
        expect(order).toEqual(['free', 'nodata', 'paid']);
    });

    it('stable: repeated sorts produce same order', () => {
        const builder = createMockBuilder(MODELS, MODELS_DATA);
        builder.sortBank('tier');
        const first = builder.getRenderedOrder();
        builder.sortBank('tier');
        const second = builder.getRenderedOrder();
        builder.sortBank('tier');
        const third = builder.getRenderedOrder();
        expect(first).toEqual(second);
        expect(second).toEqual(third);
    });

    it('tie-break uses displayName then modelId', () => {
        const tieData = {
            'z-model': { displayName: 'Same', tier: 'LIGHT', pricing: { input: 1, output: 1 } },
            'a-model': { displayName: 'Same', tier: 'LIGHT', pricing: { input: 1, output: 1 } },
            'm-model': { displayName: 'Same', tier: 'LIGHT', pricing: { input: 1, output: 1 } }
        };
        const builder = createMockBuilder(['z-model', 'a-model', 'm-model'], tieData);
        builder.sortBank('tier');
        const order = builder.getRenderedOrder();
        // Same displayName, tie-break by modelId alphabetically
        expect(order).toEqual(['a-model', 'm-model', 'z-model']);
    });

    it('handles unknown tier gracefully (sorts to end)', () => {
        const unknownData = {
            'known': { displayName: 'Known', tier: 'HEAVY', pricing: { input: 1, output: 1 } },
            'unknown': { displayName: 'Unknown', tier: 'CUSTOM', pricing: { input: 1, output: 1 } },
            'none': { displayName: 'None', pricing: { input: 1, output: 1 } }
        };
        const builder = createMockBuilder(['unknown', 'known', 'none'], unknownData);
        builder.sortBank('tier');
        const order = builder.getRenderedOrder();
        // HEAVY=0, then unknowns (tier=99) tie-break by name
        expect(order[0]).toBe('known');
    });

    it('does nothing when _bankModels is null', () => {
        const builder = createMockBuilder(MODELS, MODELS_DATA);
        builder._bankModels = null;
        builder.sortBank('name');
        expect(builder.getRenderedOrder()).toBeNull();
    });
});
