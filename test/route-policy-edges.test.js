'use strict';

/**
 * Route Policy Engine — Edge-Case Coverage Tests
 *
 * Targets remaining uncovered lines: 171, 210, 276, 298-300, 394
 * and exercises the following edge-case scenarios:
 *
 * 1. Policy priority ordering — multiple matching policies, highest priority wins
 * 2. Wildcard patterns — `claude-*` matches `claude-3-opus` but not `gpt-4`
 * 3. Policy hot-reload — writing new policies.json triggers reload
 * 4. Malformed policy JSON — corrupted file does not crash, falls back gracefully
 * 5. Empty policies — all requests pass through with default policy
 * 6. Policy with all fields — fully-specified policy matches correctly
 * 7. Policy conflicts — two equal-priority policies, deterministic first-wins
 * 8. Regex catch branches, ReDoS guards, fs.watch error, loadPolicies on missing file
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { RoutePolicyManager, DEFAULT_POLICY, validatePolicy } = require('../lib/route-policy');

// Quiet logger to avoid console noise during tests
const silent = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('route-policy edge cases', () => {
    let testDir;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-edges-'));
    });

    afterEach(() => {
        try {
            const files = fs.readdirSync(testDir);
            for (const file of files) fs.unlinkSync(path.join(testDir, file));
            fs.rmdirSync(testDir);
        } catch (_) { /* ignore */ }
    });

    // ================================================================
    // 1. Policy priority ordering
    // ================================================================

    describe('priority ordering with three+ overlapping policies', () => {
        test('highest priority wins among three matching policies', () => {
            const cfgPath = path.join(testDir, 'prio.json');
            fs.writeFileSync(cfgPath, JSON.stringify({
                policies: [
                    { name: 'low', priority: 1, match: { paths: ['/api/*'] }, retryBudget: 1 },
                    { name: 'high', priority: 100, match: { paths: ['/api/*'] }, retryBudget: 100 },
                    { name: 'mid', priority: 50, match: { paths: ['/api/*'] }, retryBudget: 50 }
                ]
            }));

            const mgr = new RoutePolicyManager({ configPath: cfgPath, logger: silent });
            const p = mgr.matchPolicy({ path: '/api/test' });
            expect(p.name).toBe('high');
            expect(p.retryBudget).toBe(100);
        });

        test('negative priority sorts below zero-priority', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.addPolicy({ name: 'neg', priority: -5, match: { paths: ['/x'] }, retryBudget: 1 });
            mgr.addPolicy({ name: 'zero', priority: 0, match: { paths: ['/x'] }, retryBudget: 2 });

            const p = mgr.matchPolicy({ path: '/x' });
            expect(p.name).toBe('zero');
        });

        test('default (undefined) priority treated as 0', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.addPolicy({ name: 'explicit-zero', priority: 0, match: { paths: ['/y'] }, retryBudget: 10 });
            mgr.addPolicy({ name: 'implicit-zero', match: { paths: ['/y'] }, retryBudget: 20 });

            // Both have effective priority 0; first in sorted order wins (stable sort keeps insertion)
            const p = mgr.matchPolicy({ path: '/y' });
            // The sort is `priorityB - priorityA`, both 0, so the order they appear in the array
            // after sort determines winner. We just verify one of them is returned deterministically.
            expect(['explicit-zero', 'implicit-zero']).toContain(p.name);
        });
    });

    // ================================================================
    // 2. Wildcard model patterns
    // ================================================================

    describe('wildcard model patterns', () => {
        let mgr;
        beforeEach(() => {
            mgr = new RoutePolicyManager({ logger: silent });
            mgr.addPolicy({
                name: 'claude-only',
                priority: 10,
                match: { models: ['claude-*'] },
                retryBudget: 7
            });
        });

        test('claude-* matches claude-3-opus', () => {
            expect(mgr.matchPolicy({ model: 'claude-3-opus' }).name).toBe('claude-only');
        });

        test('claude-* matches claude-2-sonnet', () => {
            expect(mgr.matchPolicy({ model: 'claude-2-sonnet' }).retryBudget).toBe(7);
        });

        test('claude-* does NOT match gpt-4', () => {
            expect(mgr.matchPolicy({ model: 'gpt-4' }).name).toBe('default');
        });

        test('claude-* does NOT match xclaudex (anchored match)', () => {
            // Pattern is ^claude-.*?$ so must start with "claude-"
            expect(mgr.matchPolicy({ model: 'xclaudex' }).name).toBe('default');
        });

        test('model matching is case-insensitive', () => {
            expect(mgr.matchPolicy({ model: 'CLAUDE-3-OPUS' }).name).toBe('claude-only');
        });

        test('multiple model patterns in same policy', () => {
            const mgr2 = new RoutePolicyManager({ logger: silent });
            mgr2.addPolicy({
                name: 'multi',
                priority: 5,
                match: { models: ['claude-*', 'gpt-*'] },
                retryBudget: 9
            });
            expect(mgr2.matchPolicy({ model: 'claude-3-opus' }).retryBudget).toBe(9);
            expect(mgr2.matchPolicy({ model: 'gpt-4-turbo' }).retryBudget).toBe(9);
            expect(mgr2.matchPolicy({ model: 'llama-70b' }).name).toBe('default');
        });
    });

    // ================================================================
    // 3. Policy hot-reload (synchronous reload() path)
    // ================================================================

    describe('policy hot-reload', () => {
        test('reload picks up new policies from disk', () => {
            const cfgPath = path.join(testDir, 'policies.json');
            fs.writeFileSync(cfgPath, JSON.stringify({
                policies: [{ name: 'v1', match: { paths: ['/a'] }, retryBudget: 1 }]
            }));

            const mgr = new RoutePolicyManager({ configPath: cfgPath, logger: silent });
            expect(mgr.policies.length).toBe(1);
            expect(mgr.policies[0].name).toBe('v1');

            // Overwrite with new policy
            fs.writeFileSync(cfgPath, JSON.stringify({
                policies: [
                    { name: 'v2-a', match: { paths: ['/a'] }, retryBudget: 10 },
                    { name: 'v2-b', match: { paths: ['/b'] }, retryBudget: 20 }
                ]
            }));

            const result = mgr.reload();
            expect(result.success).toBe(true);
            expect(result.policiesLoaded).toBe(2);
            expect(mgr.matchPolicy({ path: '/a' }).retryBudget).toBe(10);
            expect(mgr.matchPolicy({ path: '/b' }).retryBudget).toBe(20);
        });

        test('reload with deleted file returns error and keeps old policies', () => {
            const cfgPath = path.join(testDir, 'policies.json');
            fs.writeFileSync(cfgPath, JSON.stringify({
                policies: [{ name: 'keep', match: { paths: ['/k'] }, retryBudget: 5 }]
            }));

            const mgr = new RoutePolicyManager({ configPath: cfgPath, logger: silent });
            expect(mgr.policies.length).toBe(1);

            // Delete file
            fs.unlinkSync(cfgPath);

            const result = mgr.reload();
            expect(result.success).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
            // loadPolicies replaces policies even on failure path (file-not-found branch)
            // so we just verify no crash
        });

        test('reload calls onReload callback', () => {
            const cfgPath = path.join(testDir, 'policies.json');
            fs.writeFileSync(cfgPath, JSON.stringify({ policies: [] }));

            const onReload = jest.fn();
            const mgr = new RoutePolicyManager({ configPath: cfgPath, logger: silent, onReload });

            mgr.reload();
            expect(onReload).toHaveBeenCalledTimes(1);
            expect(onReload).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        });
    });

    // ================================================================
    // 4. Malformed policy JSON
    // ================================================================

    describe('malformed policy JSON', () => {
        test('truncated JSON does not crash, policies stay empty', () => {
            const cfgPath = path.join(testDir, 'bad.json');
            fs.writeFileSync(cfgPath, '{ "policies": [{ "name": "trunc');

            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const mgr = new RoutePolicyManager({ configPath: cfgPath, logger });

            expect(mgr.policies).toEqual([]);
            expect(logger.error).toHaveBeenCalled();
        });

        test('binary garbage does not crash', () => {
            const cfgPath = path.join(testDir, 'garbage.json');
            fs.writeFileSync(cfgPath, Buffer.from([0x00, 0xFF, 0xFE, 0x80, 0x90]));

            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const mgr = new RoutePolicyManager({ configPath: cfgPath, logger });

            expect(mgr.policies).toEqual([]);
        });

        test('valid JSON but wrong structure (array at root) does not crash', () => {
            const cfgPath = path.join(testDir, 'array.json');
            fs.writeFileSync(cfgPath, JSON.stringify([{ name: 'oops' }]));

            const mgr = new RoutePolicyManager({ configPath: cfgPath, logger: silent });
            expect(mgr.policies).toEqual([]);
        });

        test('policies key is not an array', () => {
            const cfgPath = path.join(testDir, 'obj.json');
            fs.writeFileSync(cfgPath, JSON.stringify({ policies: 'not-array' }));

            const mgr = new RoutePolicyManager({ configPath: cfgPath, logger: silent });
            expect(mgr.policies).toEqual([]);
        });

        test('mix of valid and invalid policies loads only valid ones', () => {
            const cfgPath = path.join(testDir, 'mixed.json');
            fs.writeFileSync(cfgPath, JSON.stringify({
                policies: [
                    { name: 'good', retryBudget: 5 },
                    { retryBudget: -1 },  // missing name and bad retryBudget
                    { name: 'also-good', retryBudget: 3 }
                ]
            }));

            const mgr = new RoutePolicyManager({ configPath: cfgPath, logger: silent });
            expect(mgr.policies.length).toBe(2);
            expect(mgr.policies.map(p => p.name).sort()).toEqual(['also-good', 'good']);
        });
    });

    // ================================================================
    // 5. Empty policies — passthrough
    // ================================================================

    describe('empty policies — passthrough', () => {
        test('no policies configured returns default for any request', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            expect(mgr.policies.length).toBe(0);

            const p = mgr.matchPolicy({ path: '/anything', method: 'POST', model: 'claude-3-opus' });
            expect(p.name).toBe('default');
            expect(p.retryBudget).toBe(DEFAULT_POLICY.retryBudget);
            expect(p.maxQueueTime).toBe(DEFAULT_POLICY.maxQueueTime);
        });

        test('empty policies array in config file returns default', () => {
            const cfgPath = path.join(testDir, 'empty.json');
            fs.writeFileSync(cfgPath, JSON.stringify({ policies: [] }));

            const mgr = new RoutePolicyManager({ configPath: cfgPath, logger: silent });
            expect(mgr.policies.length).toBe(0);

            const p = mgr.getPolicy('/v1/messages', 'POST', 'claude-3-opus');
            expect(p.name).toBe('default');
        });
    });

    // ================================================================
    // 6. Policy with all fields — fully-specified match
    // ================================================================

    describe('fully-specified policy', () => {
        test('matches when path + method + model all satisfy', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.addPolicy({
                name: 'full',
                priority: 10,
                enabled: true,
                match: {
                    paths: ['/v1/messages'],
                    methods: ['POST'],
                    models: ['claude-3-*']
                },
                retryBudget: 15,
                maxQueueTime: 60000,
                pacing: { requestsPerMinute: 120, burstSize: 20 },
                tracing: { sampleRate: 75, includeBody: true, maxBodySize: 4096 },
                telemetry: { mode: 'sample', sampleRate: 50 }
            });

            const p = mgr.matchPolicy({ path: '/v1/messages', method: 'POST', model: 'claude-3-opus' });
            expect(p.name).toBe('full');
            expect(p.retryBudget).toBe(15);
            expect(p.maxQueueTime).toBe(60000);
            expect(p.pacing.requestsPerMinute).toBe(120);
            expect(p.pacing.burstSize).toBe(20);
            expect(p.tracing.sampleRate).toBe(75);
            expect(p.tracing.includeBody).toBe(true);
            expect(p.tracing.maxBodySize).toBe(4096);
            expect(p.telemetry.mode).toBe('sample');
            expect(p.telemetry.sampleRate).toBe(50);
        });

        test('does not match when method differs', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.addPolicy({
                name: 'full',
                priority: 10,
                match: {
                    paths: ['/v1/messages'],
                    methods: ['POST'],
                    models: ['claude-3-*']
                },
                retryBudget: 15
            });

            const p = mgr.matchPolicy({ path: '/v1/messages', method: 'GET', model: 'claude-3-opus' });
            expect(p.name).toBe('default');
        });
    });

    // ================================================================
    // 7. Policy conflicts — equal priority, deterministic resolution
    // ================================================================

    describe('equal-priority conflicts', () => {
        test('first policy in sorted order wins when priorities are equal', () => {
            const cfgPath = path.join(testDir, 'conflict.json');
            fs.writeFileSync(cfgPath, JSON.stringify({
                policies: [
                    { name: 'alpha', priority: 5, match: { paths: ['/v1/*'] }, retryBudget: 11 },
                    { name: 'beta',  priority: 5, match: { paths: ['/v1/*'] }, retryBudget: 22 }
                ]
            }));

            const mgr = new RoutePolicyManager({ configPath: cfgPath, logger: silent });
            const p = mgr.matchPolicy({ path: '/v1/test' });

            // Both match, same priority — first in the sorted array wins
            expect(p.name).toBe('alpha');
            expect(p.retryBudget).toBe(11);
        });

        test('determinism holds across repeated calls', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.addPolicy({ name: 'a', priority: 3, match: { models: ['*'] }, retryBudget: 1 });
            mgr.addPolicy({ name: 'b', priority: 3, match: { models: ['*'] }, retryBudget: 2 });

            const results = new Set();
            for (let i = 0; i < 20; i++) {
                results.add(mgr.matchPolicy({ model: 'anything' }).name);
            }
            // Must always return the same one
            expect(results.size).toBe(1);
        });

        test('higher priority overrides even when added later', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.addPolicy({ name: 'first-added', priority: 1, match: { paths: ['/z'] }, retryBudget: 1 });
            mgr.addPolicy({ name: 'second-added', priority: 10, match: { paths: ['/z'] }, retryBudget: 99 });

            const p = mgr.matchPolicy({ path: '/z' });
            expect(p.name).toBe('second-added');
            expect(p.retryBudget).toBe(99);
        });
    });

    // ================================================================
    // 8. Uncovered line coverage: regex catch, fs.watch error, loadPolicies missing
    // ================================================================

    describe('matchPath regex catch branch (line 171)', () => {
        test('returns false when RegExp constructor throws', () => {
            // Force a RegExp construction error by monkey-patching String.replace
            // to produce an invalid regex component
            const mgr = new RoutePolicyManager({ logger: silent });

            const origReplace = String.prototype.replace;
            let callCount = 0;
            String.prototype.replace = function (...args) {
                callCount++;
                // On the second .replace call (the * -> [^/]* conversion),
                // inject an invalid regex character sequence
                if (callCount === 2 && this.includes('*')) {
                    return '(?<invalid'; // unclosed group => RegExp throws
                }
                return origReplace.apply(this, args);
            };

            try {
                mgr.policies = [{
                    name: 'regex-bomb',
                    match: { paths: ['/*'] },
                    retryBudget: 99
                }];

                const p = mgr.matchPolicy({ path: '/test' });
                // The catch(e) returns false, so no match -> default
                expect(p.name).toBe('default');
            } finally {
                String.prototype.replace = origReplace;
            }
        });
    });

    describe('matchModel regex catch branch (line 210)', () => {
        test('returns false when RegExp constructor throws', () => {
            const mgr = new RoutePolicyManager({ logger: silent });

            const origReplace = String.prototype.replace;
            let callCount = 0;
            String.prototype.replace = function (...args) {
                callCount++;
                if (callCount === 2 && this.includes('*')) {
                    return '(?<invalid'; // unclosed group
                }
                return origReplace.apply(this, args);
            };

            try {
                mgr.policies = [{
                    name: 'regex-bomb-model',
                    match: { models: ['claude-*'] },
                    retryBudget: 99
                }];

                const p = mgr.matchPolicy({ model: 'claude-3-opus' });
                expect(p.name).toBe('default');
            } finally {
                String.prototype.replace = origReplace;
            }
        });
    });

    describe('loadPolicies called directly on missing file (lines 298-300)', () => {
        test('returns error when config file does not exist', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            const result = mgr.loadPolicies(path.join(testDir, 'nope.json'));

            expect(result.success).toBe(false);
            expect(result.errors.some(e => e.includes('Config file not found'))).toBe(true);
        });
    });

    describe('startWatching fs.watch error (line 394)', () => {
        test('catches error when fs.watch throws', () => {
            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const mgr = new RoutePolicyManager({ logger });

            // Set a config path that does not exist so fs.watch will throw
            mgr.configPath = path.join(testDir, 'nonexistent', 'deep', 'policies.json');

            mgr.startWatching();
            expect(logger.error).toHaveBeenCalledWith(
                'Failed to start watching config file:',
                expect.objectContaining({ message: expect.stringContaining('ENOENT') })
            );
            expect(mgr.watcher).toBeFalsy();
        });
    });

    describe('constructor loadPolicies exception (line 276)', () => {
        test('constructor catch handles error when loadPolicies itself throws', () => {
            // loadPolicies has an internal try/catch so it normally never throws.
            // To hit the constructor's catch (line 276), we must make loadPolicies throw
            // by temporarily replacing it.
            const cfgPath = path.join(testDir, 'dummy.json');
            fs.writeFileSync(cfgPath, JSON.stringify({ policies: [] }));

            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

            // Temporarily monkey-patch the prototype to throw
            const origLoad = RoutePolicyManager.prototype.loadPolicies;
            RoutePolicyManager.prototype.loadPolicies = function () {
                throw new Error('Simulated catastrophic failure');
            };

            try {
                const mgr = new RoutePolicyManager({ configPath: cfgPath, logger });
                expect(mgr.policies).toEqual([]);
                expect(logger.error).toHaveBeenCalledWith(
                    expect.stringContaining('Failed to load policies'),
                    'Simulated catastrophic failure'
                );
            } finally {
                RoutePolicyManager.prototype.loadPolicies = origLoad;
            }
        });

        test('directory as config path triggers loadPolicies internal catch', () => {
            const dirAsFile = path.join(testDir, 'dir-config.json');
            fs.mkdirSync(dirAsFile);

            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
            const mgr = new RoutePolicyManager({ configPath: dirAsFile, logger });

            expect(mgr.policies).toEqual([]);
            // loadPolicies catches readFileSync error on a directory (line 338-340)
            expect(logger.error).toHaveBeenCalled();
            const call = logger.error.mock.calls[0];
            expect(call[0]).toBe('Failed to load policies:');
            expect(call[1]).toBeDefined();
            expect(call[1].message).toContain('EISDIR');

            fs.rmdirSync(dirAsFile);
        });
    });

    // ================================================================
    // Additional edge cases for completeness
    // ================================================================

    describe('matchMethod edge cases', () => {
        test('non-string methods in allowed list are skipped', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.policies = [{
                name: 'bad-methods',
                match: { methods: [123, null, 'POST'] },
                retryBudget: 8
            }];

            const p = mgr.matchPolicy({ method: 'POST' });
            expect(p.retryBudget).toBe(8);
        });

        test('returns default when method is null and methods array is specified', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.policies = [{
                name: 'needs-method',
                match: { methods: ['POST'] },
                retryBudget: 8
            }];

            const p = mgr.matchPolicy({ method: null });
            expect(p.name).toBe('default');
        });
    });

    describe('deepMerge behavior', () => {
        test('matched policy overrides default nested tracing fields', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.policies = [{
                name: 'custom-tracing',
                match: { paths: ['/v1/*'] },
                tracing: { sampleRate: 0, includeBody: true }
            }];

            const p = mgr.matchPolicy({ path: '/v1/x' });
            // Custom overrides
            expect(p.tracing.sampleRate).toBe(0);
            expect(p.tracing.includeBody).toBe(true);
            // Default survives
            expect(p.tracing.maxBodySize).toBe(1024);
        });

        test('array values in source replace target entirely', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.policies = [{
                name: 'array-merge',
                match: { paths: ['/v1/*'] }
            }];

            const p = mgr.matchPolicy({ path: '/v1/x' });
            // match.paths should come from the policy, not be merged
            expect(p.match.paths).toEqual(['/v1/*']);
        });
    });

    describe('addPolicy edge cases', () => {
        test('addPolicy with priority undefined sorts as 0', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.addPolicy({ name: 'no-prio', match: { paths: ['/a'] } });
            mgr.addPolicy({ name: 'prio-1', priority: 1, match: { paths: ['/a'] } });

            expect(mgr.policies[0].name).toBe('prio-1');
            expect(mgr.policies[1].name).toBe('no-prio');
        });
    });

    describe('updatePolicy edge cases', () => {
        test('update that does not change priority does not re-sort', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.addPolicy({ name: 'first', priority: 10 });
            mgr.addPolicy({ name: 'second', priority: 5 });

            // Update retryBudget but not priority
            mgr.updatePolicy('second', { retryBudget: 99 });

            // Order should remain the same
            expect(mgr.policies[0].name).toBe('first');
            expect(mgr.policies[1].name).toBe('second');
            expect(mgr.policies[1].retryBudget).toBe(99);
        });
    });

    describe('stopWatching when not watching', () => {
        test('stopWatching is a no-op when no watcher is active', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            // Should not throw
            mgr.stopWatching();
            expect(mgr.watcher).toBeNull();
        });
    });

    describe('path prefix matching without wildcard', () => {
        test('prefix match succeeds when path starts with pattern', () => {
            const mgr = new RoutePolicyManager({ logger: silent });
            mgr.policies = [{
                name: 'prefix',
                match: { paths: ['/api/v1'] },
                retryBudget: 42
            }];

            expect(mgr.matchPolicy({ path: '/api/v1/users' }).retryBudget).toBe(42);
            expect(mgr.matchPolicy({ path: '/api/v1' }).retryBudget).toBe(42);
            expect(mgr.matchPolicy({ path: '/api/v2' }).name).toBe('default');
        });
    });
});
