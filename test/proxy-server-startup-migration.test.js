'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProxyServer } = require('../lib/proxy-server');
const { UpstreamHealthMonitor } = require('../lib/upstream-health');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');

describe('ProxyServer startup migration', () => {
    let proxyServer;
    let testDir;

    beforeEach(() => {
        resetConfig();
        resetLogger();

        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-startup-migration-'));
        fs.writeFileSync(
            path.join(testDir, 'test-keys.json'),
            JSON.stringify({
                keys: ['testkey1.secret1'],
                baseUrl: 'https://api.anthropic.com/'
            })
        );

        jest.spyOn(UpstreamHealthMonitor.prototype, 'start').mockImplementation(() => {});
    });

    afterEach(async () => {
        jest.restoreAllMocks();

        if (proxyServer) {
            await proxyServer.shutdown();
            proxyServer = null;
        }

        if (testDir) {
            fs.rmSync(testDir, { recursive: true, force: true });
            testDir = null;
        }
    });

    test('auto-migrates modelMapping into model routing during server construction', () => {
        const config = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            logLevel: 'ERROR',
            modelRouting: {
                enabled: true,
                tiers: {
                    heavy: { targetModel: 'glm-4.7', strategy: 'pool' },
                    medium: { targetModel: 'glm-4.5', strategy: 'pool' },
                    light: { targetModel: 'glm-4.5-air', strategy: 'pool' }
                },
                rules: []
            },
            modelMapping: {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-sonnet-4-20250514': 'glm-4.5'
                }
            }
        });

        proxyServer = new ProxyServer({ config });

        expect(proxyServer.modelRouter.config.version).toBe('2.0');
        expect(proxyServer.modelRouter.config.rules).toEqual(expect.arrayContaining([
            expect.objectContaining({
                match: { model: 'claude-opus-*' },
                tier: 'heavy'
            }),
            expect.objectContaining({
                match: { model: 'claude-sonnet-*' },
                tier: 'medium'
            }),
            expect.objectContaining({
                match: { model: '*' },
                tier: 'medium'
            })
        ]));
    });

    test('keeps explicit routing rules instead of replacing them with migrated model mapping rules', () => {
        const existingRule = {
            match: { model: 'claude-custom-*' },
            tier: 'light',
            comment: 'User-defined routing'
        };

        const config = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            logLevel: 'ERROR',
            modelRouting: {
                enabled: true,
                tiers: {
                    heavy: { targetModel: 'glm-4.7', strategy: 'pool' },
                    medium: { targetModel: 'glm-4.5', strategy: 'pool' },
                    light: { targetModel: 'glm-4.5-air', strategy: 'pool' }
                },
                rules: [existingRule]
            },
            modelMapping: {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7'
                }
            }
        });

        proxyServer = new ProxyServer({ config });

        expect(proxyServer.modelRouter.config.rules).toEqual([existingRule]);
        expect(proxyServer.modelRouter.config.rules).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                match: { model: 'claude-opus-*' }
            })
        ]));
    });
});
