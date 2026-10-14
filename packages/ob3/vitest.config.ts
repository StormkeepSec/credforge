import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // RDF canonicalization of a full credential takes tens of milliseconds; a few tests sign
    // hundreds of times.
    testTimeout: 30_000,
  },
});
