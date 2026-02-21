/**
 * Jest configuration for quarantined tests
 *
 * These tests have known issues and are excluded from CI gating.
 * Each test file should have a corresponding entry in QUARANTINE_EXIT.md
 * with a deadline and fix plan.
 *
 * Run with: npm run test:quarantine
 */
module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/test/quarantine/**/*.test.js'],
    verbose: true,
    // No coverage - these tests have broken mocks
    collectCoverage: false
};
