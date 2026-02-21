/**
 * Startup smoke tests.
 *
 * Guards against boot-time regressions in lib/index.js exports.
 */

'use strict';

describe('Startup smoke', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    test('require("../lib") does not throw', () => {
        expect(() => require('../lib')).not.toThrow();
    });

    test('exports startProxy and schema counters', () => {
        const lib = require('../lib');

        expect(typeof lib.startProxy).toBe('function');
        expect(lib.CounterRegistry).toBeDefined();
        expect(lib.COUNTER_SCHEMA).toBeDefined();
        expect(lib.COUNTER_LABELS).toBeDefined();
    });
});
