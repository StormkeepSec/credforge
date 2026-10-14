import { defineConfig } from 'tsup';

// Bundles each entrypoint into dist/. Workspace packages (@credforge/*) are compiled in;
// npm dependencies stay external and are installed in the Docker image.
export default defineConfig({
  entry: {
    server: 'src/server.ts',
    worker: 'src/worker.ts',
    migrate: 'src/migrate.ts',
    healthcheck: 'src/healthcheck.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  noExternal: [/^@credforge\//],
});
