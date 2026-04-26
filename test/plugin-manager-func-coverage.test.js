'use strict';
/**
 * PluginManager Function Coverage Tests
 *
 * Target: lib/plugin-manager.js - Push BRANCH coverage from 96.73% to 100%
 * Focus: Line 511 - catch block in destroy() when unregister throws
 */

const { PluginManager } = require('../lib/plugin-manager');

describe('PluginManager Function Coverage', () => {
    let mockLogger;

    beforeEach(() => {
        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('destroy() error handling', () => {
        // Covers line 511: catch block in destroy() when unregister throws
        test('logs warning when unregister throws during destroy', () => {
            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            // Register a valid plugin first
            const plugin = {
                name: 'test-plugin',
                init: jest.fn()
            };
            manager.register('test-plugin', plugin);

            // Mock unregister to throw directly (not return false)
            jest.spyOn(manager, 'unregister').mockImplementation(() => {
                throw new Error('unregister explosion');
            });

            // Should not throw - destroy catches the error
            expect(() => manager.destroy()).not.toThrow();

            // Line 511: should log warning about error during destroy
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Error unregistering plugin test-plugin during destroy')
            );
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('unregister explosion')
            );

            // Should still complete cleanup
            expect(mockLogger.info).toHaveBeenCalledWith('Plugin manager destroyed');
        });

        // Covers line 511: catch block handles multiple plugins with one throwing
        test('continues destroying other plugins when one unregister throws', () => {
            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            const plugin1 = { name: 'plugin1', init: jest.fn() };
            const plugin2 = { name: 'plugin2', init: jest.fn() };
            manager.register('plugin1', plugin1);
            manager.register('plugin2', plugin2);

            let callCount = 0;
            jest.spyOn(manager, 'unregister').mockImplementation((name) => {
                callCount++;
                if (name === 'plugin1') {
                    throw new Error('plugin1 failed');
                }
                // plugin2 succeeds - need to actually remove it
                manager.plugins.delete('plugin2');
                manager.pluginStates.delete('plugin2');
            });

            manager.destroy();

            // Both unregister calls were attempted
            expect(callCount).toBe(2);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('plugin1 failed')
            );
        });
    });
});
