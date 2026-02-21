/**
 * PluginManager Extended Tests
 * Targets uncovered lines: 228-229,237-238,244,267-268,349,491,493-494,507-510
 *
 * Focus areas:
 * - loadFromDirectory: path traversal protection, resolved path check, non-file entries, outer catch
 * - executeHook: invalid hook name rejection
 * - _createPluginLogger: debug, warn, error methods on plugin logger
 * - destroy: try/catch around unregister during destroy
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { PluginManager, BasePlugin } = require('../lib/plugin-manager');

describe('PluginManager Extended', () => {
    let testDir;
    let mockLogger;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-ext-test-'));
        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
    });

    afterEach(() => {
        try {
            const files = fs.readdirSync(testDir);
            for (const file of files) {
                const fp = path.join(testDir, file);
                const stat = fs.statSync(fp);
                if (stat.isDirectory()) {
                    fs.rmdirSync(fp);
                } else {
                    fs.unlinkSync(fp);
                }
            }
            fs.rmdirSync(testDir);
        } catch (err) {
            // Ignore cleanup errors
        }
    });

    describe('loadFromDirectory - path traversal protection', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        // Lines 228-229: Suspicious filename with path separators
        test('should skip files with ".." in filename', () => {
            // We cannot actually create a file with ".." in the name on most OS,
            // so we mock readdirSync to return a suspicious filename
            const origReaddirSync = fs.readdirSync;
            const origStatSync = fs.statSync;
            const origExistsSync = fs.existsSync;

            jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
                if (p === testDir) return true;
                return origExistsSync(p);
            });
            jest.spyOn(fs, 'readdirSync').mockImplementation((dir) => {
                if (dir === testDir) return ['..malicious.js', 'normal.js'];
                return origReaddirSync(dir);
            });
            jest.spyOn(fs, 'statSync').mockImplementation((fp) => {
                if (path.basename(fp) === 'normal.js') {
                    return { isFile: () => true };
                }
                return origStatSync(fp);
            });

            // Mock require to prevent actual file loading
            const originalPlugins = manager.plugins;

            const loaded = manager.loadFromDirectory(testDir);

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Skipping suspicious plugin filename')
            );

            jest.restoreAllMocks();
        });

        test('should skip files with forward slash in filename', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue(['sub/plugin.js']);

            manager.loadFromDirectory(testDir);

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Skipping suspicious plugin filename')
            );

            jest.restoreAllMocks();
        });

        test('should skip files with backslash in filename', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue(['sub\\plugin.js']);

            manager.loadFromDirectory(testDir);

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Skipping suspicious plugin filename')
            );

            jest.restoreAllMocks();
        });
    });

    describe('loadFromDirectory - resolved path check', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        // Lines 237-238: Resolved path not within plugin directory
        test('should skip file whose resolved path escapes plugin directory', () => {
            // Mock readdirSync to return a clean-looking filename
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockReturnValue(['legit.js']);

            // Mock path.resolve to make the file resolve outside the plugin dir
            const origResolve = path.resolve;
            jest.spyOn(path, 'resolve').mockImplementation((...args) => {
                if (args.length === 2 && args[1] === 'legit.js') {
                    // Return a path outside the plugin directory
                    return '/some/other/directory/legit.js';
                }
                if (args.length === 1 && args[0] === testDir) {
                    return testDir;
                }
                return origResolve(...args);
            });

            manager.loadFromDirectory(testDir);

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Skipping path traversal attempt')
            );

            jest.restoreAllMocks();
        });
    });

    describe('loadFromDirectory - non-file entries', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        // Line 244: stat.isFile() returns false (e.g., a subdirectory with .js name)
        test('should skip entries that are not files (e.g., directories)', () => {
            // Create a subdirectory with a .js extension
            const subDir = path.join(testDir, 'subdir.js');
            fs.mkdirSync(subDir);

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(0);
            // Should not error, just silently skip
        });
    });

    describe('loadFromDirectory - outer catch block', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        // Lines 267-268: Outer catch when readdirSync throws
        test('should handle readdirSync failure gracefully', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(true);
            jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
                throw new Error('Permission denied');
            });

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(0);
            expect(manager.stats.errors).toBe(1);
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to load plugins from'),
                'Permission denied'
            );

            jest.restoreAllMocks();
        });
    });

    describe('executeHook - invalid hook name', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        // Line 349: Invalid hook name rejection
        test('should throw on invalid hook name', async () => {
            await expect(manager.executeHook('invalidHook'))
                .rejects.toThrow('Invalid hook name: invalidHook');
        });

        test('should throw on arbitrary method name', async () => {
            await expect(manager.executeHook('constructor'))
                .rejects.toThrow('Invalid hook name: constructor');
        });

        test('should throw on empty string hook name', async () => {
            await expect(manager.executeHook(''))
                .rejects.toThrow('Invalid hook name: ');
        });

        test('should accept valid hook names', async () => {
            // Should not throw for valid hooks
            await expect(manager.executeHook('onRequest')).resolves.toEqual([]);
            await expect(manager.executeHook('onResponse')).resolves.toEqual([]);
            await expect(manager.executeHook('onError')).resolves.toEqual([]);
            await expect(manager.executeHook('onKeySelect')).resolves.toEqual([]);
            await expect(manager.executeHook('onMetrics')).resolves.toEqual([]);
        });
    });

    describe('_createPluginLogger - all log methods', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        // Lines 491, 493-494: debug, warn, error on plugin logger
        test('should create plugin logger with debug method that prefixes output', () => {
            const plugin = {
                name: 'logger-ext-test',
                init: jest.fn()
            };

            manager.register('logger-ext-test', plugin);
            const context = plugin.init.mock.calls[0][0];

            context.logger.debug('debug message', 'extra');
            expect(mockLogger.debug).toHaveBeenCalledWith(
                '[Plugin:logger-ext-test]', 'debug message', 'extra'
            );
        });

        test('should create plugin logger with warn method that prefixes output', () => {
            const plugin = {
                name: 'warn-test',
                init: jest.fn()
            };

            manager.register('warn-test', plugin);
            const context = plugin.init.mock.calls[0][0];

            context.logger.warn('warning message');
            expect(mockLogger.warn).toHaveBeenCalledWith(
                '[Plugin:warn-test]', 'warning message'
            );
        });

        test('should create plugin logger with error method that prefixes output', () => {
            const plugin = {
                name: 'error-test',
                init: jest.fn()
            };

            manager.register('error-test', plugin);
            const context = plugin.init.mock.calls[0][0];

            context.logger.error('error message', { detail: 'info' });
            expect(mockLogger.error).toHaveBeenCalledWith(
                '[Plugin:error-test]', 'error message', { detail: 'info' }
            );
        });

        test('should create plugin logger with info method that prefixes output', () => {
            const plugin = {
                name: 'info-test',
                init: jest.fn()
            };

            manager.register('info-test', plugin);
            const context = plugin.init.mock.calls[0][0];

            context.logger.info('info message');
            expect(mockLogger.info).toHaveBeenCalledWith(
                '[Plugin:info-test]', 'info message'
            );
        });
    });

    describe('destroy - cleanup with error handling', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        // Lines 507-510: destroy() try/catch around unregister
        test('should destroy all registered plugins', () => {
            const plugin1 = {
                name: 'plugin1',
                init: jest.fn(),
                destroy: jest.fn()
            };
            const plugin2 = {
                name: 'plugin2',
                init: jest.fn(),
                destroy: jest.fn()
            };

            manager.register('plugin1', plugin1);
            manager.register('plugin2', plugin2);

            manager.destroy();

            expect(plugin1.destroy).toHaveBeenCalled();
            expect(plugin2.destroy).toHaveBeenCalled();
            expect(manager.plugins.size).toBe(0);
            expect(mockLogger.info).toHaveBeenCalledWith('Plugin manager destroyed');
        });

        test('should handle error during plugin unregister in destroy gracefully', () => {
            const plugin = {
                name: 'error-destroy-plugin',
                init: jest.fn(),
                destroy: jest.fn().mockImplementation(() => {
                    throw new Error('Destroy failed');
                })
            };

            manager.register('error-destroy-plugin', plugin);

            // destroy() should not throw even when unregister encounters errors
            expect(() => manager.destroy()).not.toThrow();
            expect(mockLogger.info).toHaveBeenCalledWith('Plugin manager destroyed');
        });

        test('should remove all event listeners during destroy', () => {
            const listener = jest.fn();
            manager.on('plugin:registered', listener);

            manager.destroy();

            // After destroy, listeners should be removed
            expect(manager.listenerCount('plugin:registered')).toBe(0);
        });

        test('should handle destroy with no plugins registered', () => {
            expect(() => manager.destroy()).not.toThrow();
            expect(mockLogger.info).toHaveBeenCalledWith('Plugin manager destroyed');
        });
    });

    describe('BasePlugin extended', () => {
        test('should handle destroy without context', () => {
            const plugin = new BasePlugin('no-context');
            // destroy before init - context is null
            expect(() => plugin.destroy()).not.toThrow();
        });
    });

    describe('loadFromDirectory - autoload on constructor', () => {
        test('should autoload plugins from existing directory', () => {
            // Create a valid plugin file
            const pluginCode = `
                module.exports = {
                    name: 'auto-loaded',
                    version: '1.0.0',
                    init: function(ctx) {}
                };
            `;
            fs.writeFileSync(path.join(testDir, 'auto-loaded.js'), pluginCode);

            const manager = new PluginManager({
                pluginDir: testDir,
                autoload: true,
                logger: mockLogger
            });

            expect(manager.plugins.has('auto-loaded')).toBe(true);
        });
    });
});
