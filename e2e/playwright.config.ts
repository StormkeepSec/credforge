import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './support/stack';

/**
 * End-to-end accessibility tests against a running development stack (`pnpm infra:up`, then
 * `pnpm dev`). `setup` seeds this run's accounts (tests/seed.setup.ts); `cleanup` runs last.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: true,
  // The dev stack is shared with whoever is using it; a few workers keep it responsive.
  workers: 4,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    // A missing label or button should fail fast, not wait out the whole test.
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /\.setup\.ts$/, teardown: 'cleanup' },
    { name: 'cleanup', testMatch: /\.teardown\.ts$/ },
    { name: 'chromium', testMatch: /\.spec\.ts$/, dependencies: ['setup'] },
  ],
});
