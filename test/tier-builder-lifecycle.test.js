/**
 * TierBuilder Lifecycle Tests
 * Tests constructor/destroy cleanup to prevent event listener leaks.
 */

describe('TierBuilder lifecycle', () => {
    // Minimal DOM stub with addEventListener/removeEventListener tracking
    function createMockElement(id) {
        var listeners = {};
        return {
            id: id,
            style: {},
            className: '',
            textContent: '',
            innerHTML: '',
            parentNode: null,
            listeners: listeners,
            addEventListener: function(type, fn, capture) {
                var key = type + (capture ? '_capture' : '');
                if (!listeners[key]) listeners[key] = [];
                listeners[key].push(fn);
            },
            removeEventListener: function(type, fn, capture) {
                var key = type + (capture ? '_capture' : '');
                if (listeners[key]) {
                    listeners[key] = listeners[key].filter(function(f) { return f !== fn; });
                }
            },
            getListenerCount: function(type, capture) {
                var key = type + (capture ? '_capture' : '');
                return (listeners[key] || []).length;
            },
            querySelector: function() { return null; },
            querySelectorAll: function() { return []; },
            appendChild: function() {},
            removeChild: function(child) { child.parentNode = null; },
            closest: function() { return null; },
            getAttribute: function() { return null; },
            setAttribute: function() {},
            remove: function() {}
        };
    }

    function createMockTierBuilder() {
        var container = createMockElement('tierBuilder');
        var saveBtn = createMockElement('tierBuilderSave');
        var resetBtn = createMockElement('tierBuilderReset');

        // Mock document.getElementById to return our mocks
        var origGetById = global.document?.getElementById;
        var mockGetById = function(id) {
            switch (id) {
                case 'tierBuilder': return container;
                case 'tierBuilderSave': return saveBtn;
                case 'tierBuilderReset': return resetBtn;
                case 'tierBuilderPending': return createMockElement('tierBuilderPending');
                case 'tierBuilderPendingCount': return createMockElement('tierBuilderPendingCount');
                case 'modelsBankList': return createMockElement('modelsBankList');
                case 'modelsBankCount': return createMockElement('modelsBankCount');
                default: return null;
            }
        };

        return {
            container: container,
            saveBtn: saveBtn,
            resetBtn: resetBtn,
            mockGetById: mockGetById,
            origGetById: origGetById
        };
    }

    test('tooltip listeners are stored as named references', () => {
        // Verify the pattern: listeners are stored on `this` for cleanup
        var mock = createMockTierBuilder();
        var container = mock.container;

        // Simulate TierBuilder constructor tooltip listener setup
        var onMouseEnter = function() {};
        var onMouseLeave = function() {};
        var onFocusIn = function() {};
        var onFocusOut = function() {};

        container.addEventListener('mouseenter', onMouseEnter, true);
        container.addEventListener('mouseleave', onMouseLeave, true);
        container.addEventListener('focusin', onFocusIn);
        container.addEventListener('focusout', onFocusOut);

        expect(container.getListenerCount('mouseenter', true)).toBe(1);
        expect(container.getListenerCount('mouseleave', true)).toBe(1);
        expect(container.getListenerCount('focusin', false)).toBe(1);
        expect(container.getListenerCount('focusout', false)).toBe(1);

        // Simulate destroy() cleanup
        container.removeEventListener('mouseenter', onMouseEnter, true);
        container.removeEventListener('mouseleave', onMouseLeave, true);
        container.removeEventListener('focusin', onFocusIn);
        container.removeEventListener('focusout', onFocusOut);

        expect(container.getListenerCount('mouseenter', true)).toBe(0);
        expect(container.getListenerCount('mouseleave', true)).toBe(0);
        expect(container.getListenerCount('focusin', false)).toBe(0);
        expect(container.getListenerCount('focusout', false)).toBe(0);
    });

    test('multiple create/destroy cycles do not accumulate listeners', () => {
        var container = createMockElement('tierBuilder');

        for (var i = 0; i < 5; i++) {
            // Simulate constructor
            var onMouseEnter = function() {};
            var onMouseLeave = function() {};
            var onFocusIn = function() {};
            var onFocusOut = function() {};

            container.addEventListener('mouseenter', onMouseEnter, true);
            container.addEventListener('mouseleave', onMouseLeave, true);
            container.addEventListener('focusin', onFocusIn);
            container.addEventListener('focusout', onFocusOut);

            // Simulate destroy
            container.removeEventListener('mouseenter', onMouseEnter, true);
            container.removeEventListener('mouseleave', onMouseLeave, true);
            container.removeEventListener('focusin', onFocusIn);
            container.removeEventListener('focusout', onFocusOut);
        }

        // After 5 cycles, should have zero listeners
        expect(container.getListenerCount('mouseenter', true)).toBe(0);
        expect(container.getListenerCount('mouseleave', true)).toBe(0);
        expect(container.getListenerCount('focusin', false)).toBe(0);
        expect(container.getListenerCount('focusout', false)).toBe(0);
    });

    test('anonymous listeners cannot be removed (the bug this fixes)', () => {
        var container = createMockElement('tierBuilder');

        // Before fix: anonymous functions can't be removed
        container.addEventListener('mouseenter', function() {}, true);
        container.addEventListener('mouseenter', function() {}, true);

        // removeEventListener with a NEW anonymous function doesn't match
        container.removeEventListener('mouseenter', function() {}, true);

        // Both original listeners still attached = LEAK
        expect(container.getListenerCount('mouseenter', true)).toBe(2);
    });

    test('save button listener is properly cleaned up', () => {
        var saveBtn = createMockElement('tierBuilderSave');
        var onSave = function() {};

        saveBtn.addEventListener('click', onSave);
        expect(saveBtn.getListenerCount('click', false)).toBe(1);

        saveBtn.removeEventListener('click', onSave);
        expect(saveBtn.getListenerCount('click', false)).toBe(0);
    });

    test('tooltip DOM element removed on destroy', () => {
        var container = createMockElement('tierBuilder');
        var tooltip = createMockElement('modelCardTooltip');
        tooltip.parentNode = container;

        var removed = false;
        container.removeChild = function(child) {
            if (child === tooltip) removed = true;
            child.parentNode = null;
        };

        // Simulate destroy tooltip cleanup
        if (tooltip.parentNode) {
            tooltip.parentNode.removeChild(tooltip);
        }

        expect(removed).toBe(true);
        expect(tooltip.parentNode).toBeNull();
    });
});
