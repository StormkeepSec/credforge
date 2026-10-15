import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.{ts,tsx}'],
          exclude: ['test/integration/**'],
        },
      },
      {
        // Against a real PostgreSQL: a Testcontainers container (needs Docker), or the server in
        // TEST_DATABASE_URL (an owner/superuser connection string; each test file gets its own
        // database there).
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
