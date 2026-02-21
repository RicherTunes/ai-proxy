/**
 * Jest configuration for stress tests
 *
 * These tests are resource-intensive and may be flaky under load.
 * Intended for nightly runs or manual validation.
 *
 * Run with: npm run test:stress
 */
module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/test/stress/**/*.test.js'],
    verbose: true,
    testTimeout: 60000, // Stress tests may need longer timeouts
    collectCoverage: false
};
