'use strict';

/**
 * Route Policy Engine Tests
 *
 * Tests cover the RoutePolicyManager implementation:
 * - Constructor and initialization
 * - Policy validation (required fields, types, ranges)
 * - Pattern matching (paths, models, methods, combined)
 * - Policy priority and selection
 * - CRUD operations (add, update, remove, get)
 * - matchPolicy() with merging
 * - Hot reload with file watching
 * - Edge cases (empty policies, disabled, invalid configs)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { RoutePolicyManager, DEFAULT_POLICY, validatePolicy } = require('../lib/route-policy');

describe('RoutePolicyManager', () => {
    let testDir;
    let testConfigPath;

    beforeEach(() => {
        // Create unique temp directory for each test
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-policy-test-'));
        testConfigPath = path.join(testDir, 'policies.json');
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
        test('should export RoutePolicyManager class', () => {
            expect(RoutePolicyManager).toBeDefined();
            expect(typeof RoutePolicyManager).toBe('function');
        });

        test('should export DEFAULT_POLICY', () => {
            expect(DEFAULT_POLICY).toBeDefined();
            expect(DEFAULT_POLICY.name).toBe('default');
            expect(DEFAULT_POLICY.retryBudget).toBe(3);
            expect(DEFAULT_POLICY.maxQueueTime).toBe(30000);
        });

        test('should export validatePolicy function', () => {
            expect(validatePolicy).toBeDefined();
            expect(typeof validatePolicy).toBe('function');
        });
    });

    describe('constructor', () => {
        test('should initialize with default options', () => {
            const manager = new RoutePolicyManager();
            expect(manager.policies).toEqual([]);
            expect(manager.defaultPolicy).toEqual(DEFAULT_POLICY);
            expect(manager.configPath).toBeUndefined();
        });

        test('should accept custom logger', () => {
            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const manager = new RoutePolicyManager({ logger });
            expect(manager.logger).toBe(logger);
        });

        test('should have empty policies array initially', () => {
            const manager = new RoutePolicyManager();
            expect(manager.policies).toBeInstanceOf(Array);
            expect(manager.policies.length).toBe(0);
        });

        test('should load policies from configPath if provided', () => {
            const config = {
                policies: [
                    {
                        name: 'test-policy',
                        match: { paths: ['/v1/*'] },
                        retryBudget: 5
                    }
                ]
            };
            fs.writeFileSync(testConfigPath, JSON.stringify(config));

            const manager = new RoutePolicyManager({ configPath: testConfigPath });
            expect(manager.policies.length).toBe(1);
            expect(manager.policies[0].name).toBe('test-policy');
        });

        test('should handle missing config file gracefully', () => {
            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const manager = new RoutePolicyManager({
                configPath: path.join(testDir, 'nonexistent.json'),
                logger
            });

            expect(manager.policies.length).toBe(0);
            // Missing config file logs info (not error) and skips loading
            expect(logger.error).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('policies disabled'));
        });

        test('should accept onReload callback', () => {
            const onReload = jest.fn();
            const manager = new RoutePolicyManager({ onReload });
            expect(manager.onReload).toBe(onReload);
        });
    });

    describe('policy validation', () => {
        test('should validate required name field', () => {
            const result = validatePolicy({});
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Policy name is required and must be a string');
        });

        test('should reject null policy', () => {
            const result = validatePolicy(null);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Policy is required');
        });

        test('should reject invalid policy structure', () => {
            const result = validatePolicy({ name: 123 });
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        test('should accept valid policy with all fields', () => {
            const policy = {
                name: 'full-policy',
                match: {
                    paths: ['/v1/*'],
                    methods: ['POST'],
                    models: ['claude-*']
                },
                retryBudget: 5,
                maxQueueTime: 60000,
                pacing: {
                    requestsPerMinute: 100,
                    burstSize: 10
                },
                tracing: {
                    sampleRate: 50,
                    includeBody: true,
                    maxBodySize: 2048
                },
                telemetry: {
                    mode: 'sample',
                    sampleRate: 25
                },
                priority: 10,
                enabled: true
            };

            const result = validatePolicy(policy);
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        test('should accept minimal valid policy', () => {
            const policy = { name: 'minimal' };
            const result = validatePolicy(policy);
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        test('should reject invalid retryBudget', () => {
            const result = validatePolicy({ name: 'test', retryBudget: -1 });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('retryBudget'))).toBe(true);
        });

        test('should reject invalid maxQueueTime', () => {
            const result = validatePolicy({ name: 'test', maxQueueTime: 'not-a-number' });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('maxQueueTime'))).toBe(true);
        });

        test('should reject invalid match.paths type', () => {
            const result = validatePolicy({ name: 'test', match: { paths: 'not-an-array' } });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('match.paths'))).toBe(true);
        });

        test('should reject invalid match.methods type', () => {
            const result = validatePolicy({ name: 'test', match: { methods: 'GET' } });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('match.methods'))).toBe(true);
        });

        test('should reject invalid match.models type', () => {
            const result = validatePolicy({ name: 'test', match: { models: 'claude-*' } });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('match.models'))).toBe(true);
        });

        test('should reject invalid pacing.requestsPerMinute', () => {
            const result = validatePolicy({
                name: 'test',
                pacing: { requestsPerMinute: -10 }
            });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('pacing.requestsPerMinute'))).toBe(true);
        });

        test('should reject invalid tracing.sampleRate', () => {
            const result = validatePolicy({
                name: 'test',
                tracing: { sampleRate: 150 }
            });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('tracing.sampleRate'))).toBe(true);
        });

        test('should reject invalid telemetry.mode', () => {
            const result = validatePolicy({
                name: 'test',
                telemetry: { mode: 'invalid-mode' }
            });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('telemetry.mode'))).toBe(true);
        });

        test('should accept valid telemetry modes', () => {
            const modes = ['normal', 'drop', 'sample'];
            modes.forEach(mode => {
                const result = validatePolicy({
                    name: 'test',
                    telemetry: { mode }
                });
                expect(result.valid).toBe(true);
            });
        });

        test('should reject invalid priority type', () => {
            const result = validatePolicy({ name: 'test', priority: 'high' });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('priority'))).toBe(true);
        });

        test('should reject invalid enabled type', () => {
            const result = validatePolicy({ name: 'test', enabled: 'yes' });
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('enabled'))).toBe(true);
        });

        test('should accept null pacing', () => {
            const result = validatePolicy({ name: 'test', pacing: null });
            expect(result.valid).toBe(true);
        });
    });

    describe('pattern matching', () => {
        describe('path matching', () => {
            test('should match exact path', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'exact',
                    match: { paths: ['/v1/messages'] },
                    retryBudget: 5
                }];

                const policy = manager.matchPolicy({ path: '/v1/messages' });
                expect(policy.retryBudget).toBe(5);
            });

            test('should match prefix with wildcard', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'wildcard',
                    match: { paths: ['/v1/*'] },
                    retryBudget: 5
                }];

                const policy1 = manager.matchPolicy({ path: '/v1/messages' });
                const policy2 = manager.matchPolicy({ path: '/v1/models' });
                const policy3 = manager.matchPolicy({ path: '/v2/messages' });

                expect(policy1.retryBudget).toBe(5);
                expect(policy2.retryBudget).toBe(5);
                expect(policy3.retryBudget).toBe(3); // default
            });

            test('should return default policy when no match', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'specific',
                    match: { paths: ['/v1/messages'] },
                    retryBudget: 5
                }];

                const policy = manager.matchPolicy({ path: '/v2/messages' });
                expect(policy.retryBudget).toBe(3); // default
            });

            test('should handle multiple path patterns', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'multi',
                    match: { paths: ['/v1/*', '/v2/messages'] },
                    retryBudget: 5
                }];

                const policy1 = manager.matchPolicy({ path: '/v1/anything' });
                const policy2 = manager.matchPolicy({ path: '/v2/messages' });
                const policy3 = manager.matchPolicy({ path: '/v3/other' });

                expect(policy1.retryBudget).toBe(5);
                expect(policy2.retryBudget).toBe(5);
                expect(policy3.retryBudget).toBe(3);
            });

            test('should handle complex wildcard patterns', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'complex',
                    match: { paths: ['/api/*/v1/*'] },
                    retryBudget: 5
                }];

                const policy1 = manager.matchPolicy({ path: '/api/users/v1/list' });
                const policy2 = manager.matchPolicy({ path: '/api/v1/list' });

                expect(policy1.retryBudget).toBe(5);
                expect(policy2.retryBudget).toBe(3); // no match
            });
        });

        describe('model matching', () => {
            test('should match exact model', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'exact-model',
                    match: { models: ['claude-3-opus'] },
                    retryBudget: 5
                }];

                const policy = manager.matchPolicy({ model: 'claude-3-opus' });
                expect(policy.retryBudget).toBe(5);
            });

            test('should match model with glob pattern', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'glob-model',
                    match: { models: ['claude-*'] },
                    retryBudget: 5
                }];

                const policy1 = manager.matchPolicy({ model: 'claude-3-opus' });
                const policy2 = manager.matchPolicy({ model: 'claude-2-sonnet' });
                const policy3 = manager.matchPolicy({ model: 'gpt-4' });

                expect(policy1.retryBudget).toBe(5);
                expect(policy2.retryBudget).toBe(5);
                expect(policy3.retryBudget).toBe(3); // no match
            });

            test('should match all models with wildcard', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'all-models',
                    match: { models: ['*'] },
                    retryBudget: 5
                }];

                const policy1 = manager.matchPolicy({ model: 'claude-3-opus' });
                const policy2 = manager.matchPolicy({ model: 'gpt-4' });

                expect(policy1.retryBudget).toBe(5);
                expect(policy2.retryBudget).toBe(5);
            });

            test('should be case insensitive for model matching', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'case-test',
                    match: { models: ['Claude-*'] },
                    retryBudget: 5
                }];

                const policy = manager.matchPolicy({ model: 'claude-3-opus' });
                expect(policy.retryBudget).toBe(5);
            });
        });

        describe('method matching', () => {
            test('should match HTTP method case-insensitively', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'method-test',
                    match: { methods: ['POST'] },
                    retryBudget: 5
                }];

                const policy1 = manager.matchPolicy({ method: 'POST' });
                const policy2 = manager.matchPolicy({ method: 'post' });
                const policy3 = manager.matchPolicy({ method: 'GET' });

                expect(policy1.retryBudget).toBe(5);
                expect(policy2.retryBudget).toBe(5);
                expect(policy3.retryBudget).toBe(3); // no match
            });

            test('should match array of methods', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'multi-method',
                    match: { methods: ['POST', 'PUT', 'PATCH'] },
                    retryBudget: 5
                }];

                const policy1 = manager.matchPolicy({ method: 'POST' });
                const policy2 = manager.matchPolicy({ method: 'PUT' });
                const policy3 = manager.matchPolicy({ method: 'GET' });

                expect(policy1.retryBudget).toBe(5);
                expect(policy2.retryBudget).toBe(5);
                expect(policy3.retryBudget).toBe(3); // no match
            });
        });

        describe('combined matching', () => {
            test('should require all criteria to match', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'combined',
                    match: {
                        paths: ['/v1/*'],
                        methods: ['POST'],
                        models: ['claude-*']
                    },
                    retryBudget: 10
                }];

                // All match
                const policy1 = manager.matchPolicy({
                    path: '/v1/messages',
                    method: 'POST',
                    model: 'claude-3-opus'
                });
                expect(policy1.retryBudget).toBe(10);

                // Path doesn't match
                const policy2 = manager.matchPolicy({
                    path: '/v2/messages',
                    method: 'POST',
                    model: 'claude-3-opus'
                });
                expect(policy2.retryBudget).toBe(3);

                // Method doesn't match
                const policy3 = manager.matchPolicy({
                    path: '/v1/messages',
                    method: 'GET',
                    model: 'claude-3-opus'
                });
                expect(policy3.retryBudget).toBe(3);

                // Model doesn't match
                const policy4 = manager.matchPolicy({
                    path: '/v1/messages',
                    method: 'POST',
                    model: 'gpt-4'
                });
                expect(policy4.retryBudget).toBe(3);
            });

            test('should not match with partial criteria', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{
                    name: 'strict',
                    match: {
                        paths: ['/v1/*'],
                        methods: ['POST']
                    },
                    retryBudget: 10
                }];

                // Path matches, method doesn't
                const policy = manager.matchPolicy({
                    path: '/v1/messages',
                    method: 'GET'
                });
                expect(policy.retryBudget).toBe(3);
            });
        });
    });

    describe('policy priority', () => {
        test('should check higher priority policies first', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [
                {
                    name: 'low-priority',
                    match: { paths: ['/v1/*'] },
                    priority: 1,
                    retryBudget: 5
                },
                {
                    name: 'high-priority',
                    match: { paths: ['/v1/*'] },
                    priority: 10,
                    retryBudget: 20
                }
            ];

            // Re-sort to ensure proper order
            manager.policies.sort((a, b) => b.priority - a.priority);

            const policy = manager.matchPolicy({ path: '/v1/messages' });
            expect(policy.name).toBe('high-priority');
            expect(policy.retryBudget).toBe(20);
        });

        test('should use first match with equal priority', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [
                {
                    name: 'first',
                    match: { paths: ['/v1/*'] },
                    priority: 5,
                    retryBudget: 10
                },
                {
                    name: 'second',
                    match: { paths: ['/v1/*'] },
                    priority: 5,
                    retryBudget: 20
                }
            ];

            const policy = manager.matchPolicy({ path: '/v1/messages' });
            expect(policy.name).toBe('first');
        });

        test('should return default policy if no priority policies match', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [
                {
                    name: 'specific',
                    match: { paths: ['/admin/*'] },
                    priority: 10,
                    retryBudget: 20
                }
            ];

            const policy = manager.matchPolicy({ path: '/v1/messages' });
            expect(policy.name).toBe('default');
            expect(policy.retryBudget).toBe(3);
        });
    });

    describe('policy CRUD operations', () => {
        describe('addPolicy', () => {
            test('should add valid policy', () => {
                const manager = new RoutePolicyManager();
                const policy = {
                    name: 'new-policy',
                    match: { paths: ['/test/*'] },
                    retryBudget: 5
                };

                const result = manager.addPolicy(policy);
                expect(result.success).toBe(true);
                expect(manager.policies.length).toBe(1);
                expect(manager.policies[0].name).toBe('new-policy');
            });

            test('should reject invalid policy', () => {
                const manager = new RoutePolicyManager();
                const result = manager.addPolicy({ retryBudget: -1 });
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });

            test('should reject duplicate policy name', () => {
                const manager = new RoutePolicyManager();
                const policy = { name: 'duplicate', retryBudget: 5 };

                manager.addPolicy(policy);
                const result = manager.addPolicy(policy);

                expect(result.success).toBe(false);
                expect(result.error).toContain('already exists');
            });

            test('should sort by priority after adding', () => {
                const manager = new RoutePolicyManager();

                manager.addPolicy({ name: 'low', priority: 1 });
                manager.addPolicy({ name: 'high', priority: 10 });
                manager.addPolicy({ name: 'medium', priority: 5 });

                expect(manager.policies[0].name).toBe('high');
                expect(manager.policies[1].name).toBe('medium');
                expect(manager.policies[2].name).toBe('low');
            });
        });

        describe('updatePolicy', () => {
            test('should update existing policy', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [
                    { name: 'test', retryBudget: 3, priority: 1 }
                ];

                const result = manager.updatePolicy('test', { retryBudget: 10 });
                expect(result.success).toBe(true);
                expect(manager.policies[0].retryBudget).toBe(10);
            });

            test('should fail for non-existent policy', () => {
                const manager = new RoutePolicyManager();
                const result = manager.updatePolicy('nonexistent', { retryBudget: 5 });
                expect(result.success).toBe(false);
                expect(result.error).toContain('not found');
            });

            test('should validate updated policy', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{ name: 'test', retryBudget: 3 }];

                const result = manager.updatePolicy('test', { retryBudget: -1 });
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });

            test('should re-sort after priority update', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [
                    { name: 'first', priority: 10 },
                    { name: 'second', priority: 5 }
                ];

                manager.updatePolicy('second', { priority: 20 });
                expect(manager.policies[0].name).toBe('second');
                expect(manager.policies[1].name).toBe('first');
            });
        });

        describe('removePolicy', () => {
            test('should remove existing policy', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [
                    { name: 'remove-me', retryBudget: 5 }
                ];

                const result = manager.removePolicy('remove-me');
                expect(result.success).toBe(true);
                expect(manager.policies.length).toBe(0);
            });

            test('should fail for non-existent policy', () => {
                const manager = new RoutePolicyManager();
                const result = manager.removePolicy('nonexistent');
                expect(result.success).toBe(false);
                expect(result.error).toContain('not found');
            });
        });

        describe('getPolicies', () => {
            test('should return all policies', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [
                    { name: 'first' },
                    { name: 'second' }
                ];

                const policies = manager.getPolicies();
                expect(policies.length).toBe(2);
                expect(policies[0].name).toBe('first');
            });

            test('should return copy, not reference', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [{ name: 'test' }];

                const policies = manager.getPolicies();
                policies.push({ name: 'new' });

                expect(manager.policies.length).toBe(1);
            });
        });

        describe('getPolicyByName', () => {
            test('should return specific policy', () => {
                const manager = new RoutePolicyManager();
                manager.policies = [
                    { name: 'target', retryBudget: 5 },
                    { name: 'other', retryBudget: 3 }
                ];

                const policy = manager.getPolicyByName('target');
                expect(policy).toBeDefined();
                expect(policy.retryBudget).toBe(5);
            });

            test('should return null for non-existent policy', () => {
                const manager = new RoutePolicyManager();
                const policy = manager.getPolicyByName('nonexistent');
                expect(policy).toBeNull();
            });
        });
    });

    describe('matchPolicy method', () => {
        test('should return merged policy with defaults', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [{
                name: 'custom',
                match: { paths: ['/v1/*'] },
                retryBudget: 10
                // maxQueueTime not specified, should use default
            }];

            const policy = manager.matchPolicy({ path: '/v1/messages' });
            expect(policy.retryBudget).toBe(10); // custom
            expect(policy.maxQueueTime).toBe(30000); // default
            expect(policy.tracing).toBeDefined(); // default
        });

        test('should handle missing request fields gracefully', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [{
                name: 'test',
                match: { paths: ['/v1/*'] },
                retryBudget: 5
            }];

            const policy = manager.matchPolicy({ path: '/v1/messages' });
            expect(policy.retryBudget).toBe(5);
        });

        test('should return default policy for null request', () => {
            const manager = new RoutePolicyManager();
            const policy = manager.matchPolicy(null);
            expect(policy.name).toBe('default');
            expect(policy.retryBudget).toBe(3);
        });

        test('should return default policy for empty request', () => {
            const manager = new RoutePolicyManager();
            const policy = manager.matchPolicy({});
            expect(policy.name).toBe('default');
        });

        test('should deep merge nested objects', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [{
                name: 'custom',
                match: { paths: ['/v1/*'] },
                tracing: {
                    sampleRate: 50
                    // includeBody and maxBodySize should come from defaults
                }
            }];

            const policy = manager.matchPolicy({ path: '/v1/messages' });
            expect(policy.tracing.sampleRate).toBe(50);
            expect(policy.tracing.includeBody).toBe(false);
            expect(policy.tracing.maxBodySize).toBe(1024);
        });
    });

    describe('hot reload', () => {
        test('should start watching config file', () => {
            const config = { policies: [] };
            fs.writeFileSync(testConfigPath, JSON.stringify(config));

            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const manager = new RoutePolicyManager({ configPath: testConfigPath, logger });

            manager.startWatching();
            expect(manager.watcher).toBeDefined();
            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining('Watching config file')
            );

            manager.stopWatching();
        });

        test('should stop watching config file', () => {
            const config = { policies: [] };
            fs.writeFileSync(testConfigPath, JSON.stringify(config));

            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const manager = new RoutePolicyManager({ configPath: testConfigPath, logger });

            manager.startWatching();
            manager.stopWatching();

            expect(manager.watcher).toBeNull();
            expect(logger.info).toHaveBeenCalledWith('Stopped watching config file');
        });

        test('should warn when starting watch without config path', () => {
            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const manager = new RoutePolicyManager({ logger });

            manager.startWatching();
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('No config path')
            );
        });

        test('should warn when already watching', () => {
            const config = { policies: [] };
            fs.writeFileSync(testConfigPath, JSON.stringify(config));

            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const manager = new RoutePolicyManager({ configPath: testConfigPath, logger });

            manager.startWatching();
            manager.startWatching();

            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Already watching')
            );

            manager.stopWatching();
        });

        test('should reload policies when file changes', (done) => {
            const config = {
                policies: [{ name: 'initial', retryBudget: 5 }]
            };
            fs.writeFileSync(testConfigPath, JSON.stringify(config));

            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const onReload = jest.fn((result) => {
                if (result.success && result.policiesLoaded === 1) {
                    expect(manager.policies[0].retryBudget).toBe(10);
                    manager.stopWatching();
                    done();
                }
            });

            const manager = new RoutePolicyManager({
                configPath: testConfigPath,
                logger,
                onReload
            });

            manager.startWatching();

            // Give watch a moment to set up
            setTimeout(() => {
                const newConfig = {
                    policies: [{ name: 'updated', retryBudget: 10 }]
                };
                fs.writeFileSync(testConfigPath, JSON.stringify(newConfig));
            }, 100);
        }, 10000);

        test('should debounce rapid changes', (done) => {
            const config = { policies: [] };
            fs.writeFileSync(testConfigPath, JSON.stringify(config));

            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            let reloadCount = 0;
            const onReload = jest.fn(() => {
                reloadCount++;
            });

            const manager = new RoutePolicyManager({
                configPath: testConfigPath,
                logger,
                onReload
            });

            manager.startWatching();

            // Make multiple rapid changes
            setTimeout(() => {
                fs.writeFileSync(testConfigPath, JSON.stringify({ policies: [{ name: 'v1' }] }));
                fs.writeFileSync(testConfigPath, JSON.stringify({ policies: [{ name: 'v2' }] }));
                fs.writeFileSync(testConfigPath, JSON.stringify({ policies: [{ name: 'v3' }] }));
            }, 100);

            // Check reload was debounced
            setTimeout(() => {
                // Should have reloaded fewer times than changes made
                expect(reloadCount).toBeLessThan(3);
                manager.stopWatching();
                done();
            }, 1000);
        }, 10000);

        test('should call onReload callback with results', () => {
            const config = {
                policies: [{ name: 'test', retryBudget: 5 }]
            };
            fs.writeFileSync(testConfigPath, JSON.stringify(config));

            const onReload = jest.fn();
            const manager = new RoutePolicyManager({
                configPath: testConfigPath,
                onReload
            });

            manager.reload();

            expect(onReload).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: true,
                    policiesLoaded: 1
                })
            );
        });
    });

    describe('edge cases', () => {
        test('should handle empty policies array', () => {
            const manager = new RoutePolicyManager();
            const policy = manager.matchPolicy({ path: '/v1/messages' });
            expect(policy.name).toBe('default');
        });

        test('should skip disabled policies', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [
                {
                    name: 'disabled',
                    match: { paths: ['/v1/*'] },
                    retryBudget: 10,
                    enabled: false
                },
                {
                    name: 'enabled',
                    match: { paths: ['/v1/*'] },
                    retryBudget: 5,
                    enabled: true
                }
            ];

            const policy = manager.matchPolicy({ path: '/v1/messages' });
            expect(policy.name).toBe('enabled');
            expect(policy.retryBudget).toBe(5);
        });

        test('should handle policy without match rules', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [
                {
                    name: 'no-match',
                    retryBudget: 10
                    // No match field
                }
            ];

            const policy = manager.matchPolicy({ path: '/v1/messages' });
            expect(policy.name).toBe('default'); // Should skip policy without match
        });

        test('should handle invalid config file format', () => {
            fs.writeFileSync(testConfigPath, 'not valid json');

            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const manager = new RoutePolicyManager({
                configPath: testConfigPath,
                logger
            });

            expect(manager.policies.length).toBe(0);
            expect(logger.error).toHaveBeenCalled();
        });

        test('should handle config without policies array', () => {
            fs.writeFileSync(testConfigPath, JSON.stringify({ foo: 'bar' }));

            const manager = new RoutePolicyManager({ configPath: testConfigPath });
            expect(manager.policies.length).toBe(0);
        });

        test('should handle partial policy validation failures', () => {
            const config = {
                policies: [
                    { name: 'valid', retryBudget: 5 },
                    { name: 'invalid', retryBudget: -1 },
                    { name: 'also-valid', retryBudget: 3 }
                ]
            };
            fs.writeFileSync(testConfigPath, JSON.stringify(config));

            const manager = new RoutePolicyManager({ configPath: testConfigPath });
            expect(manager.policies.length).toBe(2);
            expect(manager.policies.some(p => p.name === 'valid')).toBe(true);
            expect(manager.policies.some(p => p.name === 'also-valid')).toBe(true);
        });

        test('should handle reload without config path', () => {
            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const manager = new RoutePolicyManager({ logger });

            const result = manager.reload();
            expect(result.success).toBe(false);
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('No config path')
            );
        });

        test('should handle getPolicy convenience method', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [{
                name: 'test',
                match: {
                    paths: ['/v1/*'],
                    methods: ['POST'],
                    models: ['claude-*']
                },
                retryBudget: 10
            }];

            const policy = manager.getPolicy('/v1/messages', 'POST', 'claude-3-opus');
            expect(policy.retryBudget).toBe(10);
        });

        test('should handle validatePolicy instance method', () => {
            const manager = new RoutePolicyManager();
            const result = manager.validatePolicy({ name: 'test' });
            expect(result.valid).toBe(true);
        });

        test('should handle missing path in request', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [{
                name: 'test',
                match: { paths: ['/v1/*'] },
                retryBudget: 5
            }];

            const policy = manager.matchPolicy({ method: 'POST' });
            expect(policy.name).toBe('default');
        });

        test('should handle missing model in request', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [{
                name: 'test',
                match: { models: ['claude-*'] },
                retryBudget: 5
            }];

            const policy = manager.matchPolicy({ path: '/v1/messages' });
            expect(policy.name).toBe('default');
        });

        test('should handle empty match arrays', () => {
            const manager = new RoutePolicyManager();
            manager.policies = [{
                name: 'empty',
                match: {
                    paths: [],
                    methods: [],
                    models: []
                },
                retryBudget: 5
            }];

            const policy = manager.matchPolicy({ path: '/v1/messages' });
            expect(policy.retryBudget).toBe(5); // Empty arrays match everything
        });
    });
});
