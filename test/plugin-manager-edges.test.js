/**
 * PluginManager Edge-Case Tests
 *
 * Targets edge cases and boundary conditions not covered by existing suites:
 * 1. No plugins directory — no crash, empty plugin list
 * 2. Empty plugins directory — graceful handling
 * 3. Invalid plugin file (syntax error) — logged as warning, other plugins still load
 * 4. Plugin lifecycle — init/destroy called in correct order
 * 5. Plugin hook execution — hooks called with correct args, results collected
 * 6. Plugin error isolation — one plugin throwing doesn't affect others
 * 7. Hot reload — adding a plugin at runtime via loadFromDirectory
 * 8. Plugin metadata — plugins expose name/version/description
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { PluginManager, BasePlugin } = require('../lib/plugin-manager');

describe('PluginManager Edge Cases', () => {
    let testDir;
    let mockLogger;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-edges-'));
        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
    });

    afterEach(() => {
        try {
            // Recursive cleanup
            const cleanup = (dir) => {
                if (!fs.existsSync(dir)) return;
                for (const entry of fs.readdirSync(dir)) {
                    const full = path.join(dir, entry);
                    if (fs.statSync(full).isDirectory()) {
                        cleanup(full);
                    } else {
                        fs.unlinkSync(full);
                    }
                }
                fs.rmdirSync(dir);
            };
            cleanup(testDir);
        } catch (err) {
            // Ignore cleanup errors
        }

        // Clear require cache for any plugin files we created
        for (const key of Object.keys(require.cache)) {
            if (key.includes('plugin-edges-')) {
                delete require.cache[key];
            }
        }
    });

    // ─────────────────────────────────────────────────────────
    // 1. No plugins directory
    // ─────────────────────────────────────────────────────────
    describe('no plugins directory', () => {
        test('constructor with nonexistent pluginDir does not crash and yields empty list', () => {
            const missingDir = path.join(testDir, 'does-not-exist');

            const manager = new PluginManager({
                pluginDir: missingDir,
                autoload: true,
                logger: mockLogger
            });

            expect(manager.plugins.size).toBe(0);
            expect(manager.list()).toEqual([]);
            expect(manager.stats.registered).toBe(0);
        });

        test('loadFromDirectory on nonexistent path returns 0 and warns', () => {
            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            const missingDir = path.join(testDir, 'nope');

            const loaded = manager.loadFromDirectory(missingDir);

            expect(loaded).toBe(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('does not exist')
            );
        });

        test('hooks still work with zero plugins registered', async () => {
            const manager = new PluginManager({
                pluginDir: path.join(testDir, 'missing'),
                autoload: true,
                logger: mockLogger
            });

            const req = { url: '/test' };
            const result = await manager.onRequest(req, {});

            // Should pass through original request untouched
            expect(result).toEqual(req);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 2. Empty plugins directory
    // ─────────────────────────────────────────────────────────
    describe('empty plugins directory', () => {
        test('autoload from empty directory yields zero plugins', () => {
            // testDir exists but is empty
            const manager = new PluginManager({
                pluginDir: testDir,
                autoload: true,
                logger: mockLogger
            });

            expect(manager.plugins.size).toBe(0);
            expect(manager.list()).toEqual([]);
        });

        test('loadFromDirectory on empty dir returns 0 without errors', () => {
            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(0);
            expect(manager.stats.errors).toBe(0);
        });

        test('directory containing only non-JS files loads nothing', () => {
            fs.writeFileSync(path.join(testDir, 'readme.md'), '# readme');
            fs.writeFileSync(path.join(testDir, 'config.json'), '{}');
            fs.writeFileSync(path.join(testDir, 'notes.txt'), 'hello');

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(0);
            expect(manager.stats.errors).toBe(0);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 3. Invalid plugin file (syntax error)
    // ─────────────────────────────────────────────────────────
    describe('invalid plugin file', () => {
        test('syntax error in plugin is logged and does not crash', () => {
            fs.writeFileSync(
                path.join(testDir, 'broken.js'),
                'module.exports = { this is not valid javascript %%%;'
            );

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(0);
            expect(manager.stats.errors).toBeGreaterThan(0);
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining("Failed to load plugin 'broken.js'"),
                expect.any(String)
            );
        });

        test('invalid plugin does not prevent valid siblings from loading', () => {
            // Bad plugin
            fs.writeFileSync(
                path.join(testDir, 'aaa-broken.js'),
                'throw new SyntaxError("bad");'
            );

            // Good plugin
            fs.writeFileSync(
                path.join(testDir, 'zzz-good.js'),
                `module.exports = {
                    name: 'good-plugin',
                    version: '2.0.0',
                    init: function() {}
                };`
            );

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(1);
            expect(manager.plugins.has('zzz-good')).toBe(true);
            expect(manager.stats.errors).toBeGreaterThan(0);
        });

        test('plugin that exports non-object is rejected gracefully', () => {
            fs.writeFileSync(
                path.join(testDir, 'string-export.js'),
                'module.exports = "not an object";'
            );

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(0);
            expect(manager.stats.errors).toBeGreaterThan(0);
        });

        test('plugin without init method is rejected gracefully', () => {
            fs.writeFileSync(
                path.join(testDir, 'no-init.js'),
                'module.exports = { name: "no-init-plugin" };'
            );

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(0);
            expect(manager.stats.errors).toBeGreaterThan(0);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 4. Plugin lifecycle — init/destroy order
    // ─────────────────────────────────────────────────────────
    describe('plugin lifecycle', () => {
        test('init is called during register, destroy during unregister', () => {
            const order = [];
            const plugin = {
                name: 'lifecycle',
                init: jest.fn(() => order.push('init')),
                destroy: jest.fn(() => order.push('destroy'))
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            manager.register('lifecycle', plugin);
            expect(order).toEqual(['init']);

            manager.unregister('lifecycle');
            expect(order).toEqual(['init', 'destroy']);
        });

        test('multiple plugins init in registration order', () => {
            const order = [];

            const pluginA = {
                name: 'alpha',
                init: jest.fn(() => order.push('init-alpha'))
            };
            const pluginB = {
                name: 'beta',
                init: jest.fn(() => order.push('init-beta'))
            };
            const pluginC = {
                name: 'gamma',
                init: jest.fn(() => order.push('init-gamma'))
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            manager.register('alpha', pluginA);
            manager.register('beta', pluginB);
            manager.register('gamma', pluginC);

            expect(order).toEqual(['init-alpha', 'init-beta', 'init-gamma']);
        });

        test('destroy() tears down all plugins and calls each destroy', () => {
            const destroyOrder = [];

            const makePlugin = (name) => ({
                name,
                init: jest.fn(),
                destroy: jest.fn(() => destroyOrder.push(name))
            });

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            manager.register('p1', makePlugin('p1'));
            manager.register('p2', makePlugin('p2'));
            manager.register('p3', makePlugin('p3'));

            manager.destroy();

            expect(destroyOrder).toHaveLength(3);
            expect(manager.plugins.size).toBe(0);
        });

        test('init receives a valid context with state, logger, events', () => {
            let receivedContext = null;
            const plugin = {
                name: 'ctx-check',
                init: jest.fn((ctx) => { receivedContext = ctx; })
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger,
                config: { port: 9999 }
            });

            manager.register('ctx-check', plugin);

            expect(receivedContext).not.toBeNull();
            expect(receivedContext.config).toEqual({ port: 9999 });
            expect(typeof receivedContext.logger.info).toBe('function');
            expect(typeof receivedContext.logger.debug).toBe('function');
            expect(typeof receivedContext.logger.warn).toBe('function');
            expect(typeof receivedContext.logger.error).toBe('function');
            expect(receivedContext.state).toEqual({});
            expect(receivedContext.events).toBe(manager);
        });

        test('plugin that lacks destroy is unregistered without error', () => {
            const plugin = {
                name: 'no-destroy',
                init: jest.fn()
                // no destroy method
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            manager.register('no-destroy', plugin);
            const result = manager.unregister('no-destroy');

            expect(result).toBe(true);
            expect(manager.plugins.size).toBe(0);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 5. Plugin hook execution
    // ─────────────────────────────────────────────────────────
    describe('plugin hook execution', () => {
        test('onRequest hook is called with (req, context) and can modify request', async () => {
            const plugin = {
                name: 'req-hook',
                init: jest.fn(),
                onRequest: jest.fn(async (req) => ({ ...req, injected: true }))
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.register('req-hook', plugin);

            const req = { url: '/api', method: 'POST' };
            const ctx = { requestId: 'abc' };
            const result = await manager.onRequest(req, ctx);

            expect(plugin.onRequest).toHaveBeenCalledWith(req, ctx);
            expect(result).toEqual({ url: '/api', method: 'POST', injected: true });
        });

        test('onResponse hook is called and can modify response', async () => {
            const plugin = {
                name: 'res-hook',
                init: jest.fn(),
                onResponse: jest.fn(async (res) => ({ ...res, extra: 'header' }))
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.register('res-hook', plugin);

            const res = { status: 200 };
            const ctx = { requestId: 'def' };
            const result = await manager.onResponse(res, ctx);

            expect(plugin.onResponse).toHaveBeenCalledWith(res, ctx);
            expect(result).toEqual({ status: 200, extra: 'header' });
        });

        test('onError hook is called with error and context', async () => {
            const plugin = {
                name: 'err-hook',
                init: jest.fn(),
                onError: jest.fn()
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.register('err-hook', plugin);

            const err = new Error('test error');
            const ctx = { requestId: 'ghi' };
            await manager.onError(err, ctx);

            expect(plugin.onError).toHaveBeenCalledWith(err, ctx);
        });

        test('onKeySelect hook is called and last plugin result wins', async () => {
            const plugin1 = {
                name: 'ks1',
                init: jest.fn(),
                onKeySelect: jest.fn(async () => ({ apiKey: 'key-from-p1' }))
            };
            const plugin2 = {
                name: 'ks2',
                init: jest.fn(),
                onKeySelect: jest.fn(async () => ({ apiKey: 'key-from-p2' }))
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.register('ks1', plugin1);
            manager.register('ks2', plugin2);

            const original = { apiKey: 'original' };
            const result = await manager.onKeySelect(original, {});

            expect(result).toEqual({ apiKey: 'key-from-p2' });
        });

        test('onMetrics hook is called with metrics object', async () => {
            const plugin = {
                name: 'metrics-hook',
                init: jest.fn(),
                onMetrics: jest.fn()
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.register('metrics-hook', plugin);

            const metrics = { requests: 100, p99: 45 };
            await manager.onMetrics(metrics);

            expect(plugin.onMetrics).toHaveBeenCalledWith(metrics);
        });

        test('disabled plugins are skipped during hook execution', async () => {
            const active = {
                name: 'active',
                init: jest.fn(),
                onRequest: jest.fn(async (req) => ({ ...req, active: true }))
            };
            const inactive = {
                name: 'inactive',
                enabled: false,
                init: jest.fn(),
                onRequest: jest.fn(async (req) => ({ ...req, inactive: true }))
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.register('active', active);
            manager.register('inactive', inactive);

            const result = await manager.onRequest({ base: true }, {});

            expect(active.onRequest).toHaveBeenCalled();
            expect(inactive.onRequest).not.toHaveBeenCalled();
            expect(result.active).toBe(true);
            expect(result.inactive).toBeUndefined();
        });

        test('hook stats are incremented per execution', async () => {
            const plugin = {
                name: 'stats-counter',
                init: jest.fn(),
                onRequest: jest.fn(async () => null),
                onResponse: jest.fn(async () => null),
                onMetrics: jest.fn(async () => {})
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.register('stats-counter', plugin);

            await manager.onRequest({}, {});
            await manager.onRequest({}, {});
            await manager.onResponse({}, {});
            await manager.onMetrics({});

            expect(manager.stats.hooksExecuted.onRequest).toBe(2);
            expect(manager.stats.hooksExecuted.onResponse).toBe(1);
            expect(manager.stats.hooksExecuted.onMetrics).toBe(1);
        });
    });

    // ─────────────────────────────────────────────────────────
    // 6. Plugin error isolation
    // ─────────────────────────────────────────────────────────
    describe('plugin error isolation', () => {
        test('one plugin throwing in onRequest does not prevent others from executing', async () => {
            const badPlugin = {
                name: 'bad',
                init: jest.fn(),
                onRequest: jest.fn(async () => { throw new Error('bad plugin exploded'); })
            };
            const goodPlugin = {
                name: 'good',
                init: jest.fn(),
                onRequest: jest.fn(async (req) => ({ ...req, good: true }))
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.register('bad', badPlugin);
            manager.register('good', goodPlugin);

            const result = await manager.onRequest({ url: '/test' }, {});

            // Good plugin still ran and contributed its modification
            expect(goodPlugin.onRequest).toHaveBeenCalled();
            expect(result.good).toBe(true);
            // Error was logged
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining("Plugin 'bad' hook 'onRequest' failed"),
                'bad plugin exploded'
            );
            expect(manager.stats.errors).toBeGreaterThan(0);
        });

        test('one plugin throwing in onResponse does not prevent others from executing', async () => {
            const crasher = {
                name: 'crasher',
                init: jest.fn(),
                onResponse: jest.fn(async () => { throw new Error('crasher boom'); })
            };
            const stable = {
                name: 'stable',
                init: jest.fn(),
                onResponse: jest.fn(async (res) => ({ ...res, stable: true }))
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.register('crasher', crasher);
            manager.register('stable', stable);

            const result = await manager.onResponse({ status: 200 }, {});

            expect(stable.onResponse).toHaveBeenCalled();
            expect(result.stable).toBe(true);
        });

        test('plugin:hook:error event is emitted when a hook throws', async () => {
            const plugin = {
                name: 'emit-error',
                init: jest.fn(),
                onError: jest.fn(async () => { throw new Error('hook failed'); })
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.register('emit-error', plugin);

            const hookErrorListener = jest.fn();
            manager.on('plugin:hook:error', hookErrorListener);

            await manager.onError(new Error('original'), {});

            expect(hookErrorListener).toHaveBeenCalledWith(
                'emit-error',
                'onError',
                expect.any(Error)
            );
        });

        test('error in init of one plugin does not block registration of others', () => {
            const bad = {
                name: 'bad-init',
                init: jest.fn(() => { throw new Error('init crashed'); })
            };
            const good = {
                name: 'good-init',
                init: jest.fn()
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            const r1 = manager.register('bad-init', bad);
            const r2 = manager.register('good-init', good);

            expect(r1).toBe(false);
            expect(r2).toBe(true);
            expect(manager.plugins.has('good-init')).toBe(true);
            expect(manager.plugins.has('bad-init')).toBe(false);
        });

        test('destroy is resilient when one plugin destroy throws', () => {
            const errorDestroy = {
                name: 'error-destroy',
                init: jest.fn(),
                destroy: jest.fn(() => { throw new Error('destroy boom'); })
            };
            const normalDestroy = {
                name: 'normal-destroy',
                init: jest.fn(),
                destroy: jest.fn()
            };

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.register('error-destroy', errorDestroy);
            manager.register('normal-destroy', normalDestroy);

            // Should not throw even when a plugin's destroy fails
            expect(() => manager.destroy()).not.toThrow();

            // The normal plugin is fully cleaned up; the error plugin stays
            // because unregister returns false when destroy() throws
            expect(normalDestroy.destroy).toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith('Plugin manager destroyed');
        });
    });

    // ─────────────────────────────────────────────────────────
    // 7. Hot reload — loading plugins at runtime
    // ─────────────────────────────────────────────────────────
    describe('hot reload (runtime plugin addition)', () => {
        test('calling loadFromDirectory again picks up newly added plugins', () => {
            const manager = new PluginManager({
                pluginDir: testDir,
                autoload: true,  // initial load — empty dir
                logger: mockLogger
            });

            expect(manager.plugins.size).toBe(0);

            // Add a plugin at runtime
            fs.writeFileSync(
                path.join(testDir, 'hot-plugin.js'),
                `module.exports = {
                    name: 'hot-plugin',
                    version: '3.0.0',
                    description: 'Loaded at runtime',
                    init: function() {}
                };`
            );

            const loaded = manager.loadFromDirectory(testDir);

            expect(loaded).toBe(1);
            expect(manager.plugins.has('hot-plugin')).toBe(true);
            expect(manager.get('hot-plugin').version).toBe('3.0.0');
        });

        test('re-loading directory does not duplicate already-registered plugins', () => {
            fs.writeFileSync(
                path.join(testDir, 'persistent.js'),
                `module.exports = {
                    name: 'persistent',
                    init: function() {}
                };`
            );

            const manager = new PluginManager({
                pluginDir: testDir,
                autoload: true,
                logger: mockLogger
            });

            expect(manager.plugins.size).toBe(1);

            // Second load of same directory
            const loaded = manager.loadFromDirectory(testDir);

            // Should fail to register (already registered) but not crash
            expect(loaded).toBe(0);
            expect(manager.plugins.size).toBe(1);
        });

        test('registering plugin manually at runtime works normally', () => {
            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            // Start empty
            expect(manager.plugins.size).toBe(0);

            // Add at runtime
            const plugin = {
                name: 'runtime-added',
                version: '1.2.3',
                description: 'Added at runtime',
                init: jest.fn()
            };

            const result = manager.register('runtime-added', plugin);

            expect(result).toBe(true);
            expect(manager.plugins.size).toBe(1);
            expect(plugin.init).toHaveBeenCalledTimes(1);
        });

        test('unregister then re-register same plugin name works', () => {
            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            const plugin1 = {
                name: 'recycled',
                version: '1.0.0',
                init: jest.fn(),
                destroy: jest.fn()
            };

            manager.register('recycled', plugin1);
            manager.unregister('recycled');

            const plugin2 = {
                name: 'recycled',
                version: '2.0.0',
                init: jest.fn()
            };

            const result = manager.register('recycled', plugin2);

            expect(result).toBe(true);
            expect(manager.get('recycled').version).toBe('2.0.0');
        });
    });

    // ─────────────────────────────────────────────────────────
    // 8. Plugin metadata
    // ─────────────────────────────────────────────────────────
    describe('plugin metadata', () => {
        test('list() exposes name, version, description, enabled for each plugin', () => {
            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            manager.register('meta-plugin', {
                name: 'meta-plugin',
                version: '4.5.6',
                description: 'A plugin with rich metadata',
                init: jest.fn()
            });

            const list = manager.list();

            expect(list).toHaveLength(1);
            expect(list[0]).toEqual({
                name: 'meta-plugin',
                version: '4.5.6',
                description: 'A plugin with rich metadata',
                enabled: true
            });
        });

        test('default version is 1.0.0 and default description is "No description"', () => {
            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            manager.register('minimal', {
                init: jest.fn()
            });

            const plugin = manager.get('minimal');
            expect(plugin.version).toBe('1.0.0');
            expect(plugin.description).toBe('No description');
        });

        test('getStats includes metadata for all registered plugins', () => {
            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            manager.register('a', {
                name: 'a',
                version: '1.0.0',
                description: 'Plugin A',
                init: jest.fn()
            });
            manager.register('b', {
                name: 'b',
                version: '2.0.0',
                description: 'Plugin B',
                enabled: false,
                init: jest.fn()
            });

            const stats = manager.getStats();

            expect(stats.registered).toBe(2);
            expect(stats.enabled).toBe(1);
            expect(stats.disabled).toBe(1);
            expect(stats.plugins).toHaveLength(2);
            expect(stats.plugins).toContainEqual({
                name: 'a',
                version: '1.0.0',
                description: 'Plugin A',
                enabled: true
            });
            expect(stats.plugins).toContainEqual({
                name: 'b',
                version: '2.0.0',
                description: 'Plugin B',
                enabled: false
            });
        });

        test('BasePlugin exposes metadata through constructor', () => {
            const plugin = new BasePlugin('my-base', '7.8.9', 'Base plugin description');

            expect(plugin.name).toBe('my-base');
            expect(plugin.version).toBe('7.8.9');
            expect(plugin.description).toBe('Base plugin description');
            expect(plugin.enabled).toBe(true);
        });

        test('metadata from file-loaded plugin is accessible via get()', () => {
            fs.writeFileSync(
                path.join(testDir, 'metadata-test.js'),
                `module.exports = {
                    name: 'metadata-test',
                    version: '10.20.30',
                    description: 'File-loaded plugin with metadata',
                    init: function() {}
                };`
            );

            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });
            manager.loadFromDirectory(testDir);

            const plugin = manager.get('metadata-test');
            expect(plugin).not.toBeNull();
            expect(plugin.version).toBe('10.20.30');
            expect(plugin.description).toBe('File-loaded plugin with metadata');
        });

        test('enable/disable is reflected in list() metadata', () => {
            const manager = new PluginManager({
                autoload: false,
                logger: mockLogger
            });

            manager.register('toggleable', {
                name: 'toggleable',
                init: jest.fn()
            });

            expect(manager.list()[0].enabled).toBe(true);

            manager.disable('toggleable');
            expect(manager.list()[0].enabled).toBe(false);

            manager.enable('toggleable');
            expect(manager.list()[0].enabled).toBe(true);
        });
    });
});
