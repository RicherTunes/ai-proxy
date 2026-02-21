/**
 * Tenant Manager Module Tests
 *
 * Tests cover:
 * - TenantContext: isolated key/stats management, request/error tracking
 * - TenantManager: multi-tenant orchestration, request routing, CRUD operations
 * - Integration: tenant isolation, key pool separation, stats isolation
 */

const { TenantManager, TenantContext, DEFAULT_TENANT_ID } = require('../lib/tenant-manager');

// Mock the dependencies
jest.mock('../lib/key-manager', () => {
    return {
        KeyManager: jest.fn().mockImplementation((options) => ({
            keys: [],
            loadKeys: jest.fn(function(keys) {
                this.keys = keys.map((k, i) => ({ index: i, key: k, keyId: k.split('.')[0] }));
            }),
            reloadKeys: jest.fn(function(keys) {
                const added = keys.length;
                this.keys = keys.map((k, i) => ({ index: i, key: k, keyId: k.split('.')[0] }));
                return { added, removed: 0, unchanged: 0 };
            }),
            getAggregatedStats: jest.fn(() => ({
                totalRequests: 0,
                totalSuccess: 0,
                totalErrors: 0
            })),
            destroy: jest.fn(),
            options
        }))
    };
});

jest.mock('../lib/stats-aggregator', () => {
    return {
        StatsAggregator: jest.fn().mockImplementation((options) => ({
            load: jest.fn(),
            save: jest.fn(),
            startAutoSave: jest.fn(),
            stopAutoSave: jest.fn(),
            getErrorStats: jest.fn(() => ({
                timeouts: 0,
                socketHangups: 0,
                other: 0
            })),
            options
        }))
    };
});

describe('TenantManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('module exports', () => {
        test('should export TenantManager class', () => {
            expect(TenantManager).toBeDefined();
            expect(typeof TenantManager).toBe('function');
        });

        test('should export TenantContext class', () => {
            expect(TenantContext).toBeDefined();
            expect(typeof TenantContext).toBe('function');
        });

        test('should export DEFAULT_TENANT_ID', () => {
            expect(DEFAULT_TENANT_ID).toBe('default');
        });
    });

    describe('constructor', () => {
        test('should initialize with default options', () => {
            const tm = new TenantManager();

            expect(tm.enabled).toBe(true);
            expect(tm.tenantHeader).toBe('x-tenant-id');
            expect(tm.defaultTenantId).toBe('default');
            expect(tm.strictMode).toBe(false);
            expect(tm.isolateStats).toBe(true);
        });

        test('should accept custom options', () => {
            const tm = new TenantManager({
                enabled: false,
                tenantHeader: 'x-custom-tenant',
                defaultTenantId: 'main',
                strictMode: true,
                isolateStats: false
            });

            expect(tm.enabled).toBe(false);
            expect(tm.tenantHeader).toBe('x-custom-tenant');
            expect(tm.defaultTenantId).toBe('main');
            expect(tm.strictMode).toBe(true);
            expect(tm.isolateStats).toBe(false);
        });

        test('should initialize empty tenants map', () => {
            const tm = new TenantManager();
            expect(tm.tenants).toBeInstanceOf(Map);
            expect(tm.tenants.size).toBe(0);
        });

        test('should initialize global stats', () => {
            const tm = new TenantManager();

            expect(tm.globalStats.totalRequests).toBe(0);
            expect(tm.globalStats.requestsByTenant).toEqual({});
            expect(tm.globalStats.unknownTenantRequests).toBe(0);
        });

        test('should pass manager options to tenants', () => {
            const tm = new TenantManager({
                maxConcurrencyPerKey: 5,
                rateLimitPerMinute: 100
            });

            expect(tm.managerOptions.maxConcurrencyPerKey).toBe(5);
            expect(tm.managerOptions.rateLimitPerMinute).toBe(100);
        });
    });

    describe('loadTenants', () => {
        test('should load multiple tenants', () => {
            const tm = new TenantManager();

            tm.loadTenants({
                'tenant1': { keys: ['key1', 'key2'] },
                'tenant2': { keys: ['key3'] }
            });

            expect(tm.tenants.size).toBe(2);
            expect(tm.hasTenant('tenant1')).toBe(true);
            expect(tm.hasTenant('tenant2')).toBe(true);
        });

        test('should skip tenants without keys', () => {
            const tm = new TenantManager();

            tm.loadTenants({
                'tenant1': { keys: ['key1'] },
                'tenant2': {} // No keys
            });

            expect(tm.tenants.size).toBe(1);
            expect(tm.hasTenant('tenant1')).toBe(true);
            expect(tm.hasTenant('tenant2')).toBe(false);
        });

        test('should skip tenants with non-array keys', () => {
            const tm = new TenantManager();

            tm.loadTenants({
                'tenant1': { keys: ['key1'] },
                'tenant2': { keys: 'not-an-array' }
            });

            expect(tm.tenants.size).toBe(1);
        });

        test('should handle null/undefined configs gracefully', () => {
            const tm = new TenantManager();

            expect(() => tm.loadTenants(null)).not.toThrow();
            expect(() => tm.loadTenants(undefined)).not.toThrow();
            expect(tm.tenants.size).toBe(0);
        });
    });

    describe('getTenant', () => {
        test('should return tenant context by ID', () => {
            const tm = new TenantManager();
            tm.loadTenants({
                'tenant1': { keys: ['key1'] }
            });

            const context = tm.getTenant('tenant1');

            expect(context).toBeDefined();
            expect(context.tenantId).toBe('tenant1');
        });

        test('should return null for unknown tenant', () => {
            const tm = new TenantManager();
            const context = tm.getTenant('unknown');

            expect(context).toBeNull();
        });
    });

    describe('getTenantFromRequest', () => {
        test('should extract tenant from header', () => {
            const tm = new TenantManager();
            tm.loadTenants({
                'tenant1': { keys: ['key1'] }
            });

            const req = {
                headers: { 'x-tenant-id': 'tenant1' }
            };

            const result = tm.getTenantFromRequest(req);

            expect(result.tenantId).toBe('tenant1');
            expect(result.context).toBeDefined();
            expect(result.isDefault).toBe(false);
        });

        test('should use default tenant when header missing', () => {
            const tm = new TenantManager();
            tm.loadTenants({
                'default': { keys: ['key1'] }
            });

            const req = { headers: {} };
            const result = tm.getTenantFromRequest(req);

            expect(result.tenantId).toBe('default');
            expect(result.isDefault).toBe(true);
        });

        test('should use custom tenant header', () => {
            const tm = new TenantManager({ tenantHeader: 'x-org-id' });
            tm.loadTenants({
                'org1': { keys: ['key1'] }
            });

            const req = {
                headers: { 'x-org-id': 'org1' }
            };

            const result = tm.getTenantFromRequest(req);

            expect(result.tenantId).toBe('org1');
        });

        test('should return default when multi-tenant disabled', () => {
            const tm = new TenantManager({ enabled: false });
            tm.loadTenants({
                'default': { keys: ['key1'] },
                'tenant1': { keys: ['key2'] }
            });

            const req = {
                headers: { 'x-tenant-id': 'tenant1' }
            };

            const result = tm.getTenantFromRequest(req);

            expect(result.tenantId).toBe('default');
            expect(result.isDefault).toBe(true);
        });

        test('should track global stats on request', () => {
            const tm = new TenantManager();
            tm.loadTenants({
                'tenant1': { keys: ['key1'] }
            });

            const req = { headers: { 'x-tenant-id': 'tenant1' } };

            tm.getTenantFromRequest(req);
            tm.getTenantFromRequest(req);

            expect(tm.globalStats.totalRequests).toBe(2);
            expect(tm.globalStats.requestsByTenant['tenant1']).toBe(2);
        });

        test('should track unknown tenant requests', () => {
            const tm = new TenantManager();
            tm.loadTenants({
                'default': { keys: ['key1'] }
            });

            const req = { headers: { 'x-tenant-id': 'unknown' } };

            tm.getTenantFromRequest(req);

            expect(tm.globalStats.unknownTenantRequests).toBe(1);
        });

        test('should return error in strict mode for unknown tenant', () => {
            const tm = new TenantManager({ strictMode: true });
            tm.loadTenants({
                'default': { keys: ['key1'] }
            });

            const req = { headers: { 'x-tenant-id': 'unknown' } };
            const result = tm.getTenantFromRequest(req);

            expect(result.context).toBeNull();
            expect(result.error).toBe('unknown_tenant');
        });

        test('should fall back to default in non-strict mode', () => {
            const tm = new TenantManager({ strictMode: false });
            tm.loadTenants({
                'default': { keys: ['key1'] }
            });

            const req = { headers: { 'x-tenant-id': 'unknown' } };
            const result = tm.getTenantFromRequest(req);

            expect(result.tenantId).toBe('default');
            expect(result.originalTenantId).toBe('unknown');
            expect(result.isDefault).toBe(true);
        });

        test('should record request on context', () => {
            const tm = new TenantManager();
            tm.loadTenants({
                'tenant1': { keys: ['key1'] }
            });

            const req = { headers: { 'x-tenant-id': 'tenant1' } };

            tm.getTenantFromRequest(req);

            const context = tm.getTenant('tenant1');
            expect(context.requestCount).toBe(1);
            expect(context.lastUsed).toBeDefined();
        });
    });

    describe('getAllTenantStats', () => {
        test('should return stats for all tenants', () => {
            const tm = new TenantManager();
            tm.loadTenants({
                'tenant1': { keys: ['key1'] },
                'tenant2': { keys: ['key2', 'key3'] }
            });

            const stats = tm.getAllTenantStats();

            expect(stats.enabled).toBe(true);
            expect(stats.tenantCount).toBe(2);
            expect(stats.tenants['tenant1']).toBeDefined();
            expect(stats.tenants['tenant2']).toBeDefined();
        });

        test('should include global stats', () => {
            const tm = new TenantManager();
            tm.loadTenants({ 'tenant1': { keys: ['key1'] } });

            const req = { headers: { 'x-tenant-id': 'tenant1' } };
            tm.getTenantFromRequest(req);

            const stats = tm.getAllTenantStats();

            expect(stats.globalStats.totalRequests).toBe(1);
        });

        test('should include configuration flags', () => {
            const tm = new TenantManager({
                strictMode: true,
                isolateStats: false
            });

            const stats = tm.getAllTenantStats();

            expect(stats.strictMode).toBe(true);
            expect(stats.isolateStats).toBe(false);
        });
    });

    describe('getTenantStats', () => {
        test('should return stats for specific tenant', () => {
            const tm = new TenantManager();
            tm.loadTenants({
                'tenant1': { keys: ['key1', 'key2'] }
            });

            const stats = tm.getTenantStats('tenant1');

            expect(stats.tenantId).toBe('tenant1');
            expect(stats.keyCount).toBe(2);
        });

        test('should return null for unknown tenant', () => {
            const tm = new TenantManager();
            const stats = tm.getTenantStats('unknown');

            expect(stats).toBeNull();
        });
    });

    describe('addTenant', () => {
        test('should add new tenant at runtime', () => {
            const tm = new TenantManager();

            const result = tm.addTenant('newTenant', {
                keys: ['key1', 'key2']
            });

            expect(result).toBe(true);
            expect(tm.hasTenant('newTenant')).toBe(true);
        });

        test('should reject tenant without keys', () => {
            const tm = new TenantManager();

            const result = tm.addTenant('newTenant', {});

            expect(result).toBe(false);
            expect(tm.hasTenant('newTenant')).toBe(false);
        });

        test('should reject tenant with empty keys array', () => {
            const tm = new TenantManager();

            const result = tm.addTenant('newTenant', { keys: [] });

            expect(result).toBe(false);
        });

        test('should replace existing tenant', () => {
            const tm = new TenantManager();
            tm.loadTenants({ 'tenant1': { keys: ['key1'] } });

            const result = tm.addTenant('tenant1', { keys: ['key2', 'key3'] });

            expect(result).toBe(true);
            const context = tm.getTenant('tenant1');
            expect(context.keyManager.keys.length).toBe(2);
        });
    });

    describe('removeTenant', () => {
        test('should remove existing tenant', () => {
            const tm = new TenantManager();
            tm.loadTenants({ 'tenant1': { keys: ['key1'] } });

            const result = tm.removeTenant('tenant1');

            expect(result).toBe(true);
            expect(tm.hasTenant('tenant1')).toBe(false);
        });

        test('should not remove default tenant', () => {
            const tm = new TenantManager();
            tm.loadTenants({ 'default': { keys: ['key1'] } });

            const result = tm.removeTenant('default');

            expect(result).toBe(false);
            expect(tm.hasTenant('default')).toBe(true);
        });

        test('should return false for unknown tenant', () => {
            const tm = new TenantManager();
            const result = tm.removeTenant('unknown');

            expect(result).toBe(false);
        });

        test('should call destroy on removed context', () => {
            const tm = new TenantManager();
            tm.loadTenants({ 'tenant1': { keys: ['key1'] } });

            const context = tm.getTenant('tenant1');
            const destroySpy = jest.spyOn(context, 'destroy');

            tm.removeTenant('tenant1');

            expect(destroySpy).toHaveBeenCalled();
        });
    });

    describe('updateTenantKeys', () => {
        test('should update keys for existing tenant', () => {
            const tm = new TenantManager();
            tm.loadTenants({ 'tenant1': { keys: ['key1'] } });

            const result = tm.updateTenantKeys('tenant1', ['key2', 'key3']);

            expect(result).toBeDefined();
            expect(result.added).toBe(2);
        });

        test('should return null for unknown tenant', () => {
            const tm = new TenantManager();
            const result = tm.updateTenantKeys('unknown', ['key1']);

            expect(result).toBeNull();
        });
    });

    describe('getTenantIds', () => {
        test('should return list of tenant IDs', () => {
            const tm = new TenantManager();
            tm.loadTenants({
                'tenant1': { keys: ['key1'] },
                'tenant2': { keys: ['key2'] }
            });

            const ids = tm.getTenantIds();

            expect(ids).toContain('tenant1');
            expect(ids).toContain('tenant2');
            expect(ids.length).toBe(2);
        });

        test('should return empty array when no tenants', () => {
            const tm = new TenantManager();
            const ids = tm.getTenantIds();

            expect(ids).toEqual([]);
        });
    });

    describe('hasTenant', () => {
        test('should return true for existing tenant', () => {
            const tm = new TenantManager();
            tm.loadTenants({ 'tenant1': { keys: ['key1'] } });

            expect(tm.hasTenant('tenant1')).toBe(true);
        });

        test('should return false for non-existing tenant', () => {
            const tm = new TenantManager();
            expect(tm.hasTenant('unknown')).toBe(false);
        });
    });

    describe('destroy', () => {
        test('should destroy all tenants', () => {
            const tm = new TenantManager();
            tm.loadTenants({
                'tenant1': { keys: ['key1'] },
                'tenant2': { keys: ['key2'] }
            });

            const context1 = tm.getTenant('tenant1');
            const context2 = tm.getTenant('tenant2');
            const spy1 = jest.spyOn(context1, 'destroy');
            const spy2 = jest.spyOn(context2, 'destroy');

            tm.destroy();

            expect(spy1).toHaveBeenCalled();
            expect(spy2).toHaveBeenCalled();
            expect(tm.tenants.size).toBe(0);
        });
    });

    describe('reload', () => {
        test('should destroy and reload tenants', () => {
            const tm = new TenantManager();
            tm.loadTenants({
                'tenant1': { keys: ['key1'] }
            });

            const oldContext = tm.getTenant('tenant1');
            const destroySpy = jest.spyOn(oldContext, 'destroy');

            tm.reload({
                'tenant2': { keys: ['key2'] }
            });

            expect(destroySpy).toHaveBeenCalled();
            expect(tm.hasTenant('tenant1')).toBe(false);
            expect(tm.hasTenant('tenant2')).toBe(true);
        });
    });
});

describe('TenantContext', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('constructor', () => {
        test('should create tenant context with ID and config', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] });

            expect(context.tenantId).toBe('tenant1');
            expect(context.config).toEqual({ keys: ['key1'] });
        });

        test('should initialize timestamps', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] });

            expect(context.createdAt).toBeDefined();
            expect(context.lastUsed).toBeNull();
        });

        test('should create key manager with config', () => {
            const context = new TenantContext('tenant1', {
                keys: ['key1', 'key2'],
                rateLimitPerMinute: 100
            });

            expect(context.keyManager).toBeDefined();
            expect(context.keyManager.keys.length).toBe(2);
        });

        test('should create stats aggregator when isolation enabled', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] }, {
                isolateStats: true
            });

            expect(context.statsAggregator).toBeDefined();
        });

        test('should not create stats aggregator when isolation disabled', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] }, {
                isolateStats: false
            });

            expect(context.statsAggregator).toBeNull();
        });

        test('should initialize request/error counters', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] });

            expect(context.requestCount).toBe(0);
            expect(context.errorCount).toBe(0);
        });
    });

    describe('recordRequest', () => {
        test('should increment request count', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] });

            context.recordRequest();
            context.recordRequest();

            expect(context.requestCount).toBe(2);
        });

        test('should update lastUsed timestamp', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] });

            expect(context.lastUsed).toBeNull();
            context.recordRequest();
            expect(context.lastUsed).toBeDefined();
        });
    });

    describe('recordError', () => {
        test('should increment error count', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] });

            context.recordError();
            context.recordError();

            expect(context.errorCount).toBe(2);
        });
    });

    describe('getStats', () => {
        test('should return tenant statistics', () => {
            const context = new TenantContext('tenant1', { keys: ['key1', 'key2'] });

            context.recordRequest();
            context.recordError();

            const stats = context.getStats();

            expect(stats.tenantId).toBe('tenant1');
            expect(stats.keyCount).toBe(2);
            expect(stats.requestCount).toBe(1);
            expect(stats.errorCount).toBe(1);
            expect(stats.createdAt).toBeDefined();
            expect(stats.lastUsed).toBeDefined();
        });

        test('should include key stats', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] });
            const stats = context.getStats();

            expect(stats.keyStats).toBeDefined();
        });

        test('should include aggregated stats when available', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] }, {
                isolateStats: true
            });

            const stats = context.getStats();

            expect(stats.aggregated).toBeDefined();
        });
    });

    describe('destroy', () => {
        test('should call destroy on key manager', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] });

            context.destroy();

            expect(context.keyManager.destroy).toHaveBeenCalled();
        });

        test('should save and stop stats aggregator', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] }, {
                isolateStats: true
            });

            context.destroy();

            expect(context.statsAggregator.save).toHaveBeenCalled();
            expect(context.statsAggregator.stopAutoSave).toHaveBeenCalled();
        });

        test('should not throw if stats aggregator is null', () => {
            const context = new TenantContext('tenant1', { keys: ['key1'] }, {
                isolateStats: false
            });

            expect(() => context.destroy()).not.toThrow();
        });
    });
});

describe('Tenant Isolation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should have separate key pools per tenant', () => {
        const tm = new TenantManager();
        tm.loadTenants({
            'tenant1': { keys: ['key1', 'key2'] },
            'tenant2': { keys: ['key3', 'key4', 'key5'] }
        });

        const ctx1 = tm.getTenant('tenant1');
        const ctx2 = tm.getTenant('tenant2');

        expect(ctx1.keyManager.keys.length).toBe(2);
        expect(ctx2.keyManager.keys.length).toBe(3);

        // Keys should be different
        const keys1 = ctx1.keyManager.keys.map(k => k.key);
        const keys2 = ctx2.keyManager.keys.map(k => k.key);

        expect(keys1).not.toEqual(keys2);
    });

    test('should track stats separately per tenant', () => {
        const tm = new TenantManager();
        tm.loadTenants({
            'tenant1': { keys: ['key1'] },
            'tenant2': { keys: ['key2'] }
        });

        const req1 = { headers: { 'x-tenant-id': 'tenant1' } };
        const req2 = { headers: { 'x-tenant-id': 'tenant2' } };

        tm.getTenantFromRequest(req1);
        tm.getTenantFromRequest(req1);
        tm.getTenantFromRequest(req2);

        const stats1 = tm.getTenantStats('tenant1');
        const stats2 = tm.getTenantStats('tenant2');

        expect(stats1.requestCount).toBe(2);
        expect(stats2.requestCount).toBe(1);
    });

    test('should use tenant-specific rate limits', () => {
        const tm = new TenantManager();
        tm.loadTenants({
            'tenant1': { keys: ['key1'], rateLimitPerMinute: 100 },
            'tenant2': { keys: ['key2'], rateLimitPerMinute: 50 }
        });

        const ctx1 = tm.getTenant('tenant1');
        const ctx2 = tm.getTenant('tenant2');

        // Verify different configs were passed (via mock options)
        expect(ctx1.keyManager.options.rateLimitPerMinute).toBe(100);
        expect(ctx2.keyManager.options.rateLimitPerMinute).toBe(50);
    });
});

describe('Edge Cases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should handle concurrent tenant operations', async () => {
        const tm = new TenantManager();
        tm.loadTenants({
            'tenant1': { keys: ['key1'] }
        });

        // Simulate concurrent requests
        const requests = Array.from({ length: 100 }, () => ({
            headers: { 'x-tenant-id': 'tenant1' }
        }));

        requests.forEach(req => tm.getTenantFromRequest(req));

        expect(tm.globalStats.totalRequests).toBe(100);
    });

    test('should handle empty tenant ID header', () => {
        const tm = new TenantManager();
        tm.loadTenants({
            'default': { keys: ['key1'] },
            '': { keys: ['key2'] }
        });

        const req = { headers: { 'x-tenant-id': '' } };
        const result = tm.getTenantFromRequest(req);

        // Empty string should match if tenant exists
        expect(result.context).toBeDefined();
    });

    test('should handle special characters in tenant ID', () => {
        const tm = new TenantManager();

        tm.addTenant('tenant-with-dashes', { keys: ['key1'] });
        tm.addTenant('tenant_with_underscores', { keys: ['key2'] });
        tm.addTenant('tenant.with.dots', { keys: ['key3'] });

        expect(tm.hasTenant('tenant-with-dashes')).toBe(true);
        expect(tm.hasTenant('tenant_with_underscores')).toBe(true);
        expect(tm.hasTenant('tenant.with.dots')).toBe(true);
    });

    test('should handle rapid tenant add/remove', () => {
        const tm = new TenantManager();

        for (let i = 0; i < 100; i++) {
            tm.addTenant(`tenant${i}`, { keys: ['key1'] });
        }

        expect(tm.tenants.size).toBe(100);

        for (let i = 0; i < 50; i++) {
            tm.removeTenant(`tenant${i}`);
        }

        expect(tm.tenants.size).toBe(50);
    });

    test('should preserve global stats across reload', () => {
        const tm = new TenantManager();
        tm.loadTenants({
            'tenant1': { keys: ['key1'] }
        });

        const req = { headers: { 'x-tenant-id': 'tenant1' } };
        tm.getTenantFromRequest(req);
        tm.getTenantFromRequest(req);

        // Reload with new config
        tm.reload({
            'tenant2': { keys: ['key2'] }
        });

        // Global stats should be preserved (they are not reset in reload)
        // Actually, looking at the code, reload calls destroy which clears tenants
        // but globalStats is not reset. Let me verify this is intended behavior.
        // The test as written documents current behavior.
        expect(tm.globalStats.totalRequests).toBe(2);
    });
});
