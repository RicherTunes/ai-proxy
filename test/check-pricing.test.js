/**
 * Check Pricing Script Tests
 *
 * Tests cover the scripts/check-pricing.js functionality:
 * - Fetching pricing page content
 * - Computing hash for change detection
 * - Comparing with stored hash
 * - Reporting discrepancies
 * - CLI argument handling
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

describe('check-pricing script', () => {
    let testDir;
    const scriptPath = path.join(__dirname, '..', 'scripts', 'check-pricing.js');

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-pricing-test-'));
    });

    afterEach(() => {
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

    describe('script exists', () => {
        test('script file should exist', () => {
            expect(fs.existsSync(scriptPath)).toBe(true);
        });

        test('script should be executable as node script', () => {
            const result = execSync(`node "${scriptPath}" --help`, {
                encoding: 'utf8',
                timeout: 5000
            });
            expect(result).toBeDefined();
        });
    });

    describe('--help flag', () => {
        test('should show usage information', () => {
            const result = execSync(`node "${scriptPath}" --help`, {
                encoding: 'utf8',
                timeout: 5000
            });
            expect(result).toContain('Usage');
            expect(result).toContain('pricing');
        });

        test('should show available options', () => {
            const result = execSync(`node "${scriptPath}" --help`, {
                encoding: 'utf8',
                timeout: 5000
            });
            expect(result).toContain('--config');
            expect(result).toContain('--quiet');
            expect(result).toContain('--json');
        });
    });

    describe('--check mode', () => {
        test('should compare current pricing with stored hash', () => {
            // Create a test config with known hash
            const configPath = path.join(testDir, 'pricing.json');
            const pricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {
                    'glm-5': { inputTokenPer1M: 1.00, outputTokenPer1M: 3.20 }
                }
            };
            fs.writeFileSync(configPath, JSON.stringify(pricing, null, 2));

            const result = execSync(`node "${scriptPath}" --check --config "${configPath}" --quiet`, {
                encoding: 'utf8',
                timeout: 10000
            });

            // Should complete without error
            expect(result).toBeDefined();
        });

        test('should exit with code 0 when no changes detected', () => {
            const configPath = path.join(testDir, 'pricing.json');
            const pricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {
                    'glm-5': { inputTokenPer1M: 1.00, outputTokenPer1M: 3.20 }
                }
            };
            fs.writeFileSync(configPath, JSON.stringify(pricing, null, 2));

            let exitCode = 0;
            try {
                execSync(`node "${scriptPath}" --check --config "${configPath}" --quiet`, {
                    encoding: 'utf8',
                    timeout: 10000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (err) {
                exitCode = err.status;
            }

            // Exit code 0 = no changes, 1 = changes detected, 2 = error
            expect(exitCode).toBe(0);
        });

        test('should output JSON with --json flag', () => {
            const configPath = path.join(testDir, 'pricing.json');
            const pricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {
                    'glm-5': { inputTokenPer1M: 1.00, outputTokenPer1M: 3.20 }
                }
            };
            fs.writeFileSync(configPath, JSON.stringify(pricing, null, 2));

            const result = execSync(`node "${scriptPath}" --check --config "${configPath}" --json`, {
                encoding: 'utf8',
                timeout: 10000
            });

            // Should be valid JSON
            const parsed = JSON.parse(result);
            expect(parsed).toBeDefined();
            expect(parsed.checkedAt).toBeDefined();
            expect(parsed.configPath).toBe(configPath);
        });
    });

    describe('--hash mode', () => {
        test('should compute and output hash of current config', () => {
            const configPath = path.join(testDir, 'pricing.json');
            const pricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {
                    'glm-5': { inputTokenPer1M: 1.00, outputTokenPer1M: 3.20 }
                }
            };
            fs.writeFileSync(configPath, JSON.stringify(pricing, null, 2));

            const result = execSync(`node "${scriptPath}" --hash --config "${configPath}"`, {
                encoding: 'utf8',
                timeout: 5000
            });

            // Should output a hash string
            expect(result).toMatch(/[a-f0-9]{64}/); // SHA256 hex
        });

        test('should output same hash for same config', () => {
            const configPath = path.join(testDir, 'pricing.json');
            const pricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {
                    'glm-5': { inputTokenPer1M: 1.00, outputTokenPer1M: 3.20 }
                }
            };
            fs.writeFileSync(configPath, JSON.stringify(pricing, null, 2));

            const result1 = execSync(`node "${scriptPath}" --hash --config "${configPath}" --quiet`, {
                encoding: 'utf8',
                timeout: 5000
            }).trim();

            const result2 = execSync(`node "${scriptPath}" --hash --config "${configPath}" --quiet`, {
                encoding: 'utf8',
                timeout: 5000
            }).trim();

            expect(result1).toBe(result2);
        });
    });

    describe('error handling', () => {
        test('should exit with code 2 when config not found', () => {
            let exitCode = 0;
            try {
                execSync(`node "${scriptPath}" --check --config "/nonexistent/pricing.json" --quiet`, {
                    encoding: 'utf8',
                    timeout: 5000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (err) {
                exitCode = err.status;
            }

            // Exit code 2 = error
            expect(exitCode).toBe(2);
        });

        test('should output error message when config not found', () => {
            let stderr = '';
            try {
                execSync(`node "${scriptPath}" --check --config "/nonexistent/pricing.json"`, {
                    encoding: 'utf8',
                    timeout: 5000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (err) {
                stderr = err.stderr || '';
            }

            expect(stderr).toContain('not found');
        });
    });

    describe('integration with pricing-loader', () => {
        test('should use same hash algorithm as pricing-loader', () => {
            const { computePricingHash, getDefaultPricing } = require('../lib/pricing-loader');
            const defaultPricing = getDefaultPricing();

            const configPath = path.join(testDir, 'pricing.json');
            fs.writeFileSync(configPath, JSON.stringify(defaultPricing, null, 2));

            const scriptHash = execSync(`node "${scriptPath}" --hash --config "${configPath}" --quiet`, {
                encoding: 'utf8',
                timeout: 5000
            }).trim();

            const loaderHash = computePricingHash(defaultPricing);

            expect(scriptHash).toBe(loaderHash);
        });
    });
});
