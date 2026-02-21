/**
 * PluginManager Module Tests
 *
 * Tests cover the PluginManager implementation:
 * - Constructor: Default config, custom config
 * - register/unregister: Plugin lifecycle management
 * - get/list: Plugin retrieval operations
 * - enable/disable: Plugin state management
 * - Hook execution: onRequest, onResponse, onError, onKeySelect, onMetrics
 * - Plugin context: Config, logger, state access
 * - Error handling: Invalid plugins, hook errors
 * - getStats: Statistics tracking
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { PluginManager, BasePlugin } = require('../lib/plugin-manager');

describe('PluginManager', () => {
    let testDir;
    let mockLogger;

    beforeEach(() => {
        // Create unique temp directory for each test
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-manager-test-'));

        // Mock logger
        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
    });

    afterEach(() => {
        // Clean up temp directory
        try {
            const files = fs.readdirSync(testDir);
            for (const file of files) {
                fs.unlinkSync(path.join(testDir, file));
            }
            fs.rmdirSync(testDir);
        } catch (err) {
            // Ignore cleanup errors
        }
    });

    describe('module exports', () => {
        test('should export PluginManager class', () => {
            expect(PluginManager).toBeDefined();
            expect(typeof PluginManager).toBe('function');
        });

        test('should export BasePlugin class', () => {
            expect(BasePlugin).toBeDefined();
            expect(typeof BasePlugin).toBe('function');
        });
    });

    describe('Constructor', () => {
        test('should create instance with default config', () => {
            const manager = new PluginManager();

            expect(manager).toBeInstanceOf(PluginManager);
            expect(manager.pluginDir).toBe(path.join(process.cwd(), 'plugins'));
            expect(manager.autoload).toBe(true);
            expect(manager.config).toEqual({});
            expect(manager.plugins).toBeInstanceOf(Map);
            expect(manager.plugins.size).toBe(0);
        });

        test('should create instance with custom config', () => {
            const config = { port: 3000 };
            const keyManager = { selectKey: jest.fn() };

            const manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                config,
                logger: mockLogger,
                keyManager
            });

            expect(manager.pluginDir).toBe(testDir);
            expect(manager.autoload).toBe(false);
            expect(manager.config).toBe(config);
            expect(manager.logger).toBe(mockLogger);
            expect(manager.keyManager).toBe(keyManager);
        });

        test('should initialize statistics', () => {
            const manager = new PluginManager({ autoload: false });

            expect(manager.stats).toEqual({
                registered: 0,
                enabled: 0,
                disabled: 0,
                errors: 0,
                hooksExecuted: {
                    onRequest: 0,
                    onResponse: 0,
                    onError: 0,
                    onKeySelect: 0,
                    onMetrics: 0
                }
            });
        });

        test('should not autoload if pluginDir does not exist', () => {
            const manager = new PluginManager({
                pluginDir: path.join(testDir, 'nonexistent'),
                autoload: true,
                logger: mockLogger
            });

            expect(manager.plugins.size).toBe(0);
        });
    });

    describe('register', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should register valid plugin', () => {
            const plugin = {
                name: 'test-plugin',
                version: '1.0.0',
                description: 'Test plugin',
                init: jest.fn()
            };

            const result = manager.register('test-plugin', plugin);

            expect(result).toBe(true);
            expect(plugin.init).toHaveBeenCalledTimes(1);
            expect(manager.plugins.has('test-plugin')).toBe(true);
            expect(manager.stats.registered).toBe(1);
            expect(manager.stats.enabled).toBe(1);
            expect(mockLogger.info).toHaveBeenCalledWith(
                "Plugin 'test-plugin' v1.0.0 registered"
            );
        });

        test('should use provided name over plugin.name', () => {
            const plugin = {
                name: 'original-name',
                init: jest.fn()
            };

            manager.register('override-name', plugin);

            expect(plugin.name).toBe('override-name');
            expect(manager.plugins.has('override-name')).toBe(true);
            expect(manager.plugins.has('original-name')).toBe(false);
        });

        test('should set default version and description', () => {
            const plugin = {
                name: 'minimal-plugin',
                init: jest.fn()
            };

            manager.register('minimal-plugin', plugin);

            const registered = manager.get('minimal-plugin');
            expect(registered.version).toBe('1.0.0');
            expect(registered.description).toBe('No description');
        });

        test('should register plugin as enabled by default', () => {
            const plugin = {
                name: 'enabled-plugin',
                init: jest.fn()
            };

            manager.register('enabled-plugin', plugin);

            expect(plugin.enabled).toBe(true);
            expect(manager.stats.enabled).toBe(1);
            expect(manager.stats.disabled).toBe(0);
        });

        test('should register plugin as disabled if explicitly set', () => {
            const plugin = {
                name: 'disabled-plugin',
                enabled: false,
                init: jest.fn()
            };

            manager.register('disabled-plugin', plugin);

            expect(plugin.enabled).toBe(false);
            expect(manager.stats.enabled).toBe(0);
            expect(manager.stats.disabled).toBe(1);
        });

        test('should fail if plugin is not an object', () => {
            const result = manager.register('invalid', null);

            expect(result).toBe(false);
            expect(manager.stats.errors).toBe(1);
            expect(mockLogger.error).toHaveBeenCalled();
        });

        test('should fail if plugin has no name', () => {
            const plugin = { init: jest.fn() };

            const result = manager.register(null, plugin);

            expect(result).toBe(false);
            expect(manager.stats.errors).toBe(1);
        });

        test('should fail if plugin is already registered', () => {
            const plugin1 = { name: 'duplicate', init: jest.fn() };
            const plugin2 = { name: 'duplicate', init: jest.fn() };

            manager.register('duplicate', plugin1);
            const result = manager.register('duplicate', plugin2);

            expect(result).toBe(false);
            expect(manager.plugins.size).toBe(1);
            expect(manager.stats.errors).toBe(1);
        });

        test('should fail if plugin has no init method', () => {
            const plugin = { name: 'no-init' };

            const result = manager.register('no-init', plugin);

            expect(result).toBe(false);
            expect(manager.stats.errors).toBe(1);
        });

        test('should emit plugin:registered event', () => {
            const plugin = { name: 'event-test', init: jest.fn() };
            const listener = jest.fn();

            manager.on('plugin:registered', listener);
            manager.register('event-test', plugin);

            expect(listener).toHaveBeenCalledWith('event-test', plugin);
        });

        test('should provide context to plugin init', () => {
            const plugin = {
                name: 'context-test',
                init: jest.fn()
            };

            manager.register('context-test', plugin);

            const context = plugin.init.mock.calls[0][0];
            expect(context).toHaveProperty('config');
            expect(context).toHaveProperty('logger');
            expect(context).toHaveProperty('keyManager');
            expect(context).toHaveProperty('events');
            expect(context).toHaveProperty('state');
        });
    });

    describe('unregister', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should unregister plugin', () => {
            const plugin = {
                name: 'unregister-test',
                init: jest.fn(),
                destroy: jest.fn()
            };

            manager.register('unregister-test', plugin);
            const result = manager.unregister('unregister-test');

            expect(result).toBe(true);
            expect(plugin.destroy).toHaveBeenCalledTimes(1);
            expect(manager.plugins.has('unregister-test')).toBe(false);
            expect(manager.stats.registered).toBe(0);
            expect(mockLogger.info).toHaveBeenCalledWith(
                "Plugin 'unregister-test' unregistered"
            );
        });

        test('should update stats when unregistering enabled plugin', () => {
            const plugin = { name: 'enabled', init: jest.fn(), enabled: true };

            manager.register('enabled', plugin);
            expect(manager.stats.enabled).toBe(1);

            manager.unregister('enabled');
            expect(manager.stats.enabled).toBe(0);
        });

        test('should update stats when unregistering disabled plugin', () => {
            const plugin = { name: 'disabled', init: jest.fn(), enabled: false };

            manager.register('disabled', plugin);
            expect(manager.stats.disabled).toBe(1);

            manager.unregister('disabled');
            expect(manager.stats.disabled).toBe(0);
        });

        test('should remove plugin state', () => {
            const plugin = { name: 'state-test', init: jest.fn() };

            manager.register('state-test', plugin);
            manager.pluginStates.get('state-test').someData = 'test';

            manager.unregister('state-test');

            expect(manager.pluginStates.has('state-test')).toBe(false);
        });

        test('should not fail if destroy method not present', () => {
            const plugin = { name: 'no-destroy', init: jest.fn() };

            manager.register('no-destroy', plugin);
            const result = manager.unregister('no-destroy');

            expect(result).toBe(true);
        });

        test('should fail if plugin not found', () => {
            const result = manager.unregister('nonexistent');

            expect(result).toBe(false);
            expect(manager.stats.errors).toBe(1);
            expect(mockLogger.error).toHaveBeenCalled();
        });

        test('should emit plugin:unregistered event', () => {
            const plugin = { name: 'event-test', init: jest.fn() };
            const listener = jest.fn();

            manager.register('event-test', plugin);
            manager.on('plugin:unregistered', listener);
            manager.unregister('event-test');

            expect(listener).toHaveBeenCalledWith('event-test');
        });
    });

    describe('get', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should get registered plugin', () => {
            const plugin = { name: 'get-test', init: jest.fn() };

            manager.register('get-test', plugin);
            const retrieved = manager.get('get-test');

            expect(retrieved).toBe(plugin);
        });

        test('should return null for nonexistent plugin', () => {
            const result = manager.get('nonexistent');

            expect(result).toBe(null);
        });
    });

    describe('list', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should list all plugins', () => {
            const plugin1 = {
                name: 'plugin1',
                version: '1.0.0',
                description: 'First plugin',
                init: jest.fn()
            };
            const plugin2 = {
                name: 'plugin2',
                version: '2.0.0',
                description: 'Second plugin',
                init: jest.fn()
            };

            manager.register('plugin1', plugin1);
            manager.register('plugin2', plugin2);

            const list = manager.list();

            expect(list).toHaveLength(2);
            expect(list).toContainEqual({
                name: 'plugin1',
                version: '1.0.0',
                description: 'First plugin',
                enabled: true
            });
            expect(list).toContainEqual({
                name: 'plugin2',
                version: '2.0.0',
                description: 'Second plugin',
                enabled: true
            });
        });

        test('should return empty array when no plugins', () => {
            const list = manager.list();

            expect(list).toEqual([]);
        });
    });

    describe('enable', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should enable disabled plugin', () => {
            const plugin = { name: 'enable-test', init: jest.fn(), enabled: false };

            manager.register('enable-test', plugin);
            const result = manager.enable('enable-test');

            expect(result).toBe(true);
            expect(plugin.enabled).toBe(true);
            expect(manager.stats.enabled).toBe(1);
            expect(manager.stats.disabled).toBe(0);
            expect(mockLogger.info).toHaveBeenCalledWith("Plugin 'enable-test' enabled");
        });

        test('should return true if already enabled', () => {
            const plugin = { name: 'already-enabled', init: jest.fn(), enabled: true };

            manager.register('already-enabled', plugin);
            const result = manager.enable('already-enabled');

            expect(result).toBe(true);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Plugin 'already-enabled' is already enabled"
            );
        });

        test('should fail if plugin not found', () => {
            const result = manager.enable('nonexistent');

            expect(result).toBe(false);
            expect(mockLogger.error).toHaveBeenCalled();
        });

        test('should emit plugin:enabled event', () => {
            const plugin = { name: 'event-test', init: jest.fn(), enabled: false };
            const listener = jest.fn();

            manager.register('event-test', plugin);
            manager.on('plugin:enabled', listener);
            manager.enable('event-test');

            expect(listener).toHaveBeenCalledWith('event-test');
        });
    });

    describe('disable', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should disable enabled plugin', () => {
            const plugin = { name: 'disable-test', init: jest.fn(), enabled: true };

            manager.register('disable-test', plugin);
            const result = manager.disable('disable-test');

            expect(result).toBe(true);
            expect(plugin.enabled).toBe(false);
            expect(manager.stats.enabled).toBe(0);
            expect(manager.stats.disabled).toBe(1);
            expect(mockLogger.info).toHaveBeenCalledWith("Plugin 'disable-test' disabled");
        });

        test('should return true if already disabled', () => {
            const plugin = { name: 'already-disabled', init: jest.fn(), enabled: false };

            manager.register('already-disabled', plugin);
            const result = manager.disable('already-disabled');

            expect(result).toBe(true);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                "Plugin 'already-disabled' is already disabled"
            );
        });

        test('should fail if plugin not found', () => {
            const result = manager.disable('nonexistent');

            expect(result).toBe(false);
            expect(mockLogger.error).toHaveBeenCalled();
        });

        test('should emit plugin:disabled event', () => {
            const plugin = { name: 'event-test', init: jest.fn(), enabled: true };
            const listener = jest.fn();

            manager.register('event-test', plugin);
            manager.on('plugin:disabled', listener);
            manager.disable('event-test');

            expect(listener).toHaveBeenCalledWith('event-test');
        });
    });

    describe('getStats', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should return statistics with plugin list', () => {
            const plugin = {
                name: 'stats-test',
                version: '1.0.0',
                description: 'Test',
                init: jest.fn()
            };

            manager.register('stats-test', plugin);

            const stats = manager.getStats();

            expect(stats).toMatchObject({
                registered: 1,
                enabled: 1,
                disabled: 0,
                errors: 0,
                hooksExecuted: {
                    onRequest: 0,
                    onResponse: 0,
                    onError: 0,
                    onKeySelect: 0,
                    onMetrics: 0
                }
            });
            expect(stats.plugins).toHaveLength(1);
            expect(stats.plugins[0]).toEqual({
                name: 'stats-test',
                version: '1.0.0',
                description: 'Test',
                enabled: true
            });
        });
    });

    describe('executeHook', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should execute hook on enabled plugins', async () => {
            const plugin1 = {
                name: 'plugin1',
                init: jest.fn(),
                onRequest: jest.fn().mockResolvedValue('result1')
            };
            const plugin2 = {
                name: 'plugin2',
                init: jest.fn(),
                onRequest: jest.fn().mockResolvedValue('result2')
            };

            manager.register('plugin1', plugin1);
            manager.register('plugin2', plugin2);

            const results = await manager.executeHook('onRequest', { data: 'test' });

            expect(results).toHaveLength(2);
            expect(results).toContainEqual({ plugin: 'plugin1', result: 'result1' });
            expect(results).toContainEqual({ plugin: 'plugin2', result: 'result2' });
            expect(plugin1.onRequest).toHaveBeenCalledWith({ data: 'test' });
            expect(plugin2.onRequest).toHaveBeenCalledWith({ data: 'test' });
        });

        test('should skip disabled plugins', async () => {
            const plugin1 = {
                name: 'enabled',
                init: jest.fn(),
                onRequest: jest.fn().mockResolvedValue('result')
            };
            const plugin2 = {
                name: 'disabled',
                init: jest.fn(),
                enabled: false,
                onRequest: jest.fn().mockResolvedValue('should-not-run')
            };

            manager.register('enabled', plugin1);
            manager.register('disabled', plugin2);

            const results = await manager.executeHook('onRequest');

            expect(results).toHaveLength(1);
            expect(results[0].plugin).toBe('enabled');
            expect(plugin2.onRequest).not.toHaveBeenCalled();
        });

        test('should skip plugins without hook method', async () => {
            const plugin = {
                name: 'no-hook',
                init: jest.fn()
            };

            manager.register('no-hook', plugin);

            const results = await manager.executeHook('onRequest');

            expect(results).toHaveLength(0);
        });

        test('should update hook execution stats', async () => {
            const plugin = {
                name: 'stats-test',
                init: jest.fn(),
                onRequest: jest.fn().mockResolvedValue('result')
            };

            manager.register('stats-test', plugin);

            await manager.executeHook('onRequest');
            await manager.executeHook('onRequest');

            expect(manager.stats.hooksExecuted.onRequest).toBe(2);
        });

        test('should handle hook errors gracefully', async () => {
            const plugin = {
                name: 'error-plugin',
                init: jest.fn(),
                onRequest: jest.fn().mockRejectedValue(new Error('Hook error'))
            };
            const errorListener = jest.fn();

            manager.register('error-plugin', plugin);
            manager.on('plugin:hook:error', errorListener);

            const results = await manager.executeHook('onRequest');

            expect(results).toHaveLength(0);
            expect(manager.stats.errors).toBe(1);
            expect(mockLogger.error).toHaveBeenCalled();
            expect(errorListener).toHaveBeenCalled();
        });
    });

    describe('onRequest', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should execute onRequest hook and return modified request', async () => {
            const plugin = {
                name: 'request-modifier',
                init: jest.fn(),
                onRequest: jest.fn().mockResolvedValue({ modified: true })
            };

            manager.register('request-modifier', plugin);

            const req = { original: true };
            const context = { requestId: '123' };
            const result = await manager.onRequest(req, context);

            expect(plugin.onRequest).toHaveBeenCalledWith(req, context);
            expect(result).toEqual({ original: true, modified: true });
        });

        test('should apply modifications from multiple plugins (last wins)', async () => {
            const plugin1 = {
                name: 'plugin1',
                init: jest.fn(),
                onRequest: jest.fn().mockResolvedValue({ field1: 'value1' })
            };
            const plugin2 = {
                name: 'plugin2',
                init: jest.fn(),
                onRequest: jest.fn().mockResolvedValue({ field2: 'value2' })
            };

            manager.register('plugin1', plugin1);
            manager.register('plugin2', plugin2);

            const req = { original: true };
            const result = await manager.onRequest(req, {});

            expect(result).toEqual({ original: true, field1: 'value1', field2: 'value2' });
        });

        test('should return original request if no modifications', async () => {
            const plugin = {
                name: 'no-modify',
                init: jest.fn(),
                onRequest: jest.fn().mockResolvedValue(null)
            };

            manager.register('no-modify', plugin);

            const req = { original: true };
            const result = await manager.onRequest(req, {});

            expect(result).toEqual(req);
        });
    });

    describe('onResponse', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should execute onResponse hook and return modified response', async () => {
            const plugin = {
                name: 'response-modifier',
                init: jest.fn(),
                onResponse: jest.fn().mockResolvedValue({ modified: true })
            };

            manager.register('response-modifier', plugin);

            const res = { status: 200 };
            const context = { requestId: '123' };
            const result = await manager.onResponse(res, context);

            expect(plugin.onResponse).toHaveBeenCalledWith(res, context);
            expect(result).toEqual({ status: 200, modified: true });
        });

        test('should apply modifications from multiple plugins', async () => {
            const plugin1 = {
                name: 'plugin1',
                init: jest.fn(),
                onResponse: jest.fn().mockResolvedValue({ header1: 'value1' })
            };
            const plugin2 = {
                name: 'plugin2',
                init: jest.fn(),
                onResponse: jest.fn().mockResolvedValue({ header2: 'value2' })
            };

            manager.register('plugin1', plugin1);
            manager.register('plugin2', plugin2);

            const res = { status: 200 };
            const result = await manager.onResponse(res, {});

            expect(result).toEqual({ status: 200, header1: 'value1', header2: 'value2' });
        });
    });

    describe('onError', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should execute onError hook', async () => {
            const plugin = {
                name: 'error-handler',
                init: jest.fn(),
                onError: jest.fn().mockResolvedValue(undefined)
            };

            manager.register('error-handler', plugin);

            const error = new Error('Test error');
            const context = { requestId: '123' };

            await manager.onError(error, context);

            expect(plugin.onError).toHaveBeenCalledWith(error, context);
        });
    });

    describe('onKeySelect', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should execute onKeySelect hook and return modified key', async () => {
            const plugin = {
                name: 'key-modifier',
                init: jest.fn(),
                onKeySelect: jest.fn().mockResolvedValue({ apiKey: 'modified-key' })
            };

            manager.register('key-modifier', plugin);

            const key = { apiKey: 'original-key' };
            const context = { requestId: '123' };
            const result = await manager.onKeySelect(key, context);

            expect(plugin.onKeySelect).toHaveBeenCalledWith(key, context);
            expect(result).toEqual({ apiKey: 'modified-key' });
        });

        test('should apply last plugin modification', async () => {
            const plugin1 = {
                name: 'plugin1',
                init: jest.fn(),
                onKeySelect: jest.fn().mockResolvedValue({ apiKey: 'key1' })
            };
            const plugin2 = {
                name: 'plugin2',
                init: jest.fn(),
                onKeySelect: jest.fn().mockResolvedValue({ apiKey: 'key2' })
            };

            manager.register('plugin1', plugin1);
            manager.register('plugin2', plugin2);

            const key = { apiKey: 'original' };
            const result = await manager.onKeySelect(key, {});

            expect(result).toEqual({ apiKey: 'key2' });
        });
    });

    describe('onMetrics', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should execute onMetrics hook', async () => {
            const plugin = {
                name: 'metrics-collector',
                init: jest.fn(),
                onMetrics: jest.fn().mockResolvedValue(undefined)
            };

            manager.register('metrics-collector', plugin);

            const metrics = { requests: 100, errors: 5 };

            await manager.onMetrics(metrics);

            expect(plugin.onMetrics).toHaveBeenCalledWith(metrics);
        });
    });

    describe('Plugin context', () => {
        let manager;

        beforeEach(() => {
            const config = { port: 3000 };
            const keyManager = { selectKey: jest.fn() };

            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                config,
                logger: mockLogger,
                keyManager
            });
        });

        test('should provide config to plugin', () => {
            const plugin = {
                name: 'context-test',
                init: jest.fn()
            };

            manager.register('context-test', plugin);

            const context = plugin.init.mock.calls[0][0];
            expect(context.config).toEqual({ port: 3000 });
        });

        test('should provide logger to plugin', () => {
            const plugin = {
                name: 'logger-test',
                init: jest.fn()
            };

            manager.register('logger-test', plugin);

            const context = plugin.init.mock.calls[0][0];
            expect(context.logger).toBeDefined();
            expect(typeof context.logger.info).toBe('function');

            // Test logger prefix
            context.logger.info('test message');
            expect(mockLogger.info).toHaveBeenCalledWith('[Plugin:logger-test]', 'test message');
        });

        test('should provide keyManager to plugin', () => {
            const plugin = {
                name: 'key-test',
                init: jest.fn()
            };

            manager.register('key-test', plugin);

            const context = plugin.init.mock.calls[0][0];
            expect(context.keyManager).toBeDefined();
            expect(typeof context.keyManager.selectKey).toBe('function');
        });

        test('should provide events emitter to plugin', () => {
            const plugin = {
                name: 'events-test',
                init: jest.fn()
            };

            manager.register('events-test', plugin);

            const context = plugin.init.mock.calls[0][0];
            expect(context.events).toBe(manager);
        });

        test('should provide isolated state to each plugin', () => {
            const plugin1 = {
                name: 'plugin1',
                init: jest.fn()
            };
            const plugin2 = {
                name: 'plugin2',
                init: jest.fn()
            };

            manager.register('plugin1', plugin1);
            manager.register('plugin2', plugin2);

            const context1 = plugin1.init.mock.calls[0][0];
            const context2 = plugin2.init.mock.calls[0][0];

            context1.state.data = 'plugin1-data';
            context2.state.data = 'plugin2-data';

            expect(context1.state).not.toBe(context2.state);
            expect(context1.state.data).toBe('plugin1-data');
            expect(context2.state.data).toBe('plugin2-data');
        });
    });

    describe('loadFromDirectory', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should load valid plugins from directory', () => {
            // Create plugin file
            const pluginCode = `
                module.exports = {
                    name: 'test-plugin',
                    version: '1.0.0',
                    init: function(context) {
                        this.context = context;
                    }
                };
            `;
            fs.writeFileSync(path.join(testDir, 'test-plugin.js'), pluginCode);

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(1);
            expect(manager.plugins.has('test-plugin')).toBe(true);
        });

        test('should skip non-JS files', () => {
            fs.writeFileSync(path.join(testDir, 'readme.txt'), 'Not a plugin');

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(0);
        });

        test('should handle directory not found', () => {
            const loaded = manager.loadFromDirectory(path.join(testDir, 'nonexistent'));

            expect(loaded).toBe(0);
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        test('should handle plugin with default export', () => {
            const pluginCode = `
                module.exports.default = {
                    name: 'default-export',
                    init: function() {}
                };
            `;
            fs.writeFileSync(path.join(testDir, 'default-plugin.js'), pluginCode);

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(1);
            expect(manager.plugins.has('default-plugin')).toBe(true);
        });

        test('should handle plugin load errors gracefully', () => {
            // Create invalid plugin file
            fs.writeFileSync(path.join(testDir, 'invalid.js'), 'invalid javascript code {{{');

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(0);
            expect(manager.stats.errors).toBeGreaterThan(0);
        });
    });

    describe('BasePlugin', () => {
        test('should create base plugin instance', () => {
            const plugin = new BasePlugin('test', '1.0.0', 'Test plugin');

            expect(plugin.name).toBe('test');
            expect(plugin.version).toBe('1.0.0');
            expect(plugin.description).toBe('Test plugin');
            expect(plugin.enabled).toBe(true);
            expect(plugin.context).toBe(null);
        });

        test('should set default version and description', () => {
            const plugin = new BasePlugin('minimal');

            expect(plugin.version).toBe('1.0.0');
            expect(plugin.description).toBe('No description');
        });

        test('should call init with context', () => {
            const plugin = new BasePlugin('init-test');
            const mockContext = {
                logger: {
                    info: jest.fn(),
                    error: jest.fn(),
                    warn: jest.fn(),
                    debug: jest.fn()
                }
            };

            plugin.init(mockContext);

            expect(plugin.context).toBe(mockContext);
            expect(mockContext.logger.info).toHaveBeenCalledWith(
                "Initializing plugin 'init-test'"
            );
        });

        test('should call destroy', () => {
            const plugin = new BasePlugin('destroy-test');
            const mockContext = {
                logger: {
                    info: jest.fn(),
                    error: jest.fn(),
                    warn: jest.fn(),
                    debug: jest.fn()
                }
            };

            plugin.init(mockContext);
            plugin.destroy();

            expect(mockContext.logger.info).toHaveBeenCalledWith(
                "Destroying plugin 'destroy-test'"
            );
        });

        test('should have default hook implementations', async () => {
            const plugin = new BasePlugin('hooks-test');

            const req = { data: 'test' };
            const res = { status: 200 };
            const error = new Error('test');
            const key = { apiKey: 'test' };
            const metrics = { requests: 100 };

            expect(await plugin.onRequest(req)).toBe(req);
            expect(await plugin.onResponse(res)).toBe(res);
            expect(await plugin.onError(error)).toBe(undefined);
            expect(await plugin.onKeySelect(key)).toBe(key);
            expect(await plugin.onMetrics(metrics)).toBe(undefined);
        });
    });

    describe('Error handling', () => {
        let manager;

        beforeEach(() => {
            manager = new PluginManager({
                pluginDir: testDir,
                autoload: false,
                logger: mockLogger
            });
        });

        test('should handle init error gracefully', () => {
            const plugin = {
                name: 'error-init',
                init: jest.fn().mockImplementation(() => {
                    throw new Error('Init failed');
                })
            };

            const result = manager.register('error-init', plugin);

            expect(result).toBe(false);
            expect(manager.stats.errors).toBe(1);
            expect(mockLogger.error).toHaveBeenCalled();
        });

        test('should emit plugin:error event on registration error', () => {
            const plugin = {
                name: 'error-test',
                init: jest.fn().mockImplementation(() => {
                    throw new Error('Test error');
                })
            };
            const listener = jest.fn();

            manager.on('plugin:error', listener);
            manager.register('error-test', plugin);

            expect(listener).toHaveBeenCalled();
        });

        test('should handle destroy error gracefully', () => {
            const plugin = {
                name: 'error-destroy',
                init: jest.fn(),
                destroy: jest.fn().mockImplementation(() => {
                    throw new Error('Destroy failed');
                })
            };

            manager.register('error-destroy', plugin);
            const result = manager.unregister('error-destroy');

            // Unregister should fail due to error
            expect(result).toBe(false);
            expect(manager.stats.errors).toBe(1);
        });
    });
});
