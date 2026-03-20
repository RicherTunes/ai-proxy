'use strict';

/**
 * Config Validation Extended Tests
 *
 * TDD-driven: tests written FIRST, then code fixed to make them pass.
 * Validates enum-like config fields produce warnings (not errors) for invalid values.
 */

const fs = require('fs');
const { Config, resetConfig } = require('../lib/config');

describe('Config Validation Extended - Enum Warnings', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        resetConfig();
        process.env = { ...originalEnv };
        jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
            throw new Error('No keys file');
        });
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    // ─── TEST 1: Invalid logLevel produces a warning ─────────────────────
    describe('Test 1: Invalid logLevel produces a warning', () => {
        test('logLevel "VERBOSE" should produce a validation warning', () => {
            const config = new Config({ logLevel: 'VERBOSE' });
            expect(config._validationWarnings).toBeDefined();
            const logLevelWarning = config._validationWarnings.find(w => w.includes('logLevel'));
            expect(logLevelWarning).toBeDefined();
            expect(logLevelWarning).toMatch(/VERBOSE/);
        });

        test('logLevel "trace" should produce a validation warning', () => {
            const config = new Config({ logLevel: 'trace' });
            const logLevelWarning = config._validationWarnings.find(w => w.includes('logLevel'));
            expect(logLevelWarning).toBeDefined();
        });
    });

    // ─── TEST 2: Invalid logFormat produces a warning ────────────────────
    describe('Test 2: Invalid logFormat produces a warning', () => {
        test('logFormat "yaml" should produce a validation warning', () => {
            const config = new Config({ logFormat: 'yaml' });
            expect(config._validationWarnings).toBeDefined();
            const logFormatWarning = config._validationWarnings.find(w => w.includes('logFormat'));
            expect(logFormatWarning).toBeDefined();
            expect(logFormatWarning).toMatch(/yaml/);
        });

        test('logFormat "xml" should produce a validation warning', () => {
            const config = new Config({ logFormat: 'xml' });
            const logFormatWarning = config._validationWarnings.find(w => w.includes('logFormat'));
            expect(logFormatWarning).toBeDefined();
        });
    });

    // ─── TEST 3: Invalid adaptiveConcurrency.mode produces a warning ─────
    describe('Test 3: Invalid adaptiveConcurrency.mode produces a warning', () => {
        test('adaptiveConcurrency mode "unknown" should produce a validation warning', () => {
            const config = new Config({ adaptiveConcurrency: { mode: 'unknown' } });
            expect(config._validationWarnings).toBeDefined();
            const modeWarning = config._validationWarnings.find(w => w.includes('adaptiveConcurrency.mode'));
            expect(modeWarning).toBeDefined();
            expect(modeWarning).toMatch(/unknown/);
        });

        test('adaptiveConcurrency mode "auto" should produce a validation warning', () => {
            const config = new Config({ adaptiveConcurrency: { mode: 'auto' } });
            const modeWarning = config._validationWarnings.find(w => w.includes('adaptiveConcurrency.mode'));
            expect(modeWarning).toBeDefined();
        });
    });

    // ─── TEST 4: Valid config values produce no extra warnings ────────────
    describe('Test 4: Valid config values produce no extra warnings', () => {
        test('valid logLevel, logFormat, and adaptiveConcurrency.mode produce no warnings for those fields', () => {
            const config = new Config({
                logLevel: 'DEBUG',
                logFormat: 'json',
                adaptiveConcurrency: { mode: 'enforce' }
            });
            expect(config._validationWarnings).toBeDefined();

            const relevantWarnings = config._validationWarnings.filter(w =>
                w.includes('logLevel') || w.includes('logFormat') || w.includes('adaptiveConcurrency.mode')
            );
            expect(relevantWarnings).toEqual([]);
        });

        test('all four valid logLevel values produce no warnings', () => {
            for (const level of ['DEBUG', 'INFO', 'WARN', 'ERROR']) {
                const config = new Config({ logLevel: level });
                const logLevelWarning = config._validationWarnings.find(w => w.includes('logLevel'));
                expect(logLevelWarning).toBeUndefined();
            }
        });

        test('both valid logFormat values produce no warnings', () => {
            for (const fmt of ['text', 'json']) {
                const config = new Config({ logFormat: fmt });
                const logFormatWarning = config._validationWarnings.find(w => w.includes('logFormat'));
                expect(logFormatWarning).toBeUndefined();
            }
        });

        test('both valid adaptiveConcurrency.mode values produce no warnings', () => {
            for (const mode of ['observe_only', 'enforce']) {
                const config = new Config({ adaptiveConcurrency: { mode } });
                const modeWarning = config._validationWarnings.find(w => w.includes('adaptiveConcurrency.mode'));
                expect(modeWarning).toBeUndefined();
            }
        });
    });
});
