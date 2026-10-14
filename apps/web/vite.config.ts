import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development, open http://localhost:5173. Vite serves the issuer app and forwards
// everything the Fastify server owns (API, health, server-rendered pages) to it.
const serverOrigin = process.env.CREDFORGE_SERVER_ORIGIN ?? 'http://localhost:3000';
const serverPaths = [
  '/api',
  '/healthz',
  '/readyz',
  '/issuers',
  '/achievements',
  '/credentials',
  '/status',
  '/verify',
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '^/$': serverOrigin, // landing page
      ...Object.fromEntries(serverPaths.map((path) => [path, serverOrigin])),
    },
  },
  build: {
    // The server reads the manifest to find the hashed stylesheet for its own pages.
    manifest: true,
    rollupOptions: {
      input: {
        app: 'index.html',
        public: 'src/styles/public.css',
      },
    },
  },
});
