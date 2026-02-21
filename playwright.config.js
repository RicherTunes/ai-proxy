const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testMatch: '**/*.e2e.spec.js',
  globalTeardown: './test/e2e/global-teardown.js',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: 'html',

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'visual',
      testMatch: /dashboard-visual/,
      use: {
        ...devices['Desktop Chrome'],
        timezoneId: 'UTC',
        locale: 'en-US',
        reducedMotion: 'reduce',
      },
      expect: {
        toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
      },
    },
  ],
});
