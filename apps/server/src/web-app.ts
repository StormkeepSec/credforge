import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

export interface WebAppOptions {
  /** Built issuer app (apps/web/dist). */
  webDistDir: string;
}

/** Paths that load the issuer app (React SPA); its client-side router takes it from there. */
export const SPA_ROUTES = [
  '/app',
  '/app/*',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/two-factor',
  '/invite/*',
];

/**
 * Serves the built issuer app and its static assets in production.
 * In development the Vite dev server serves these instead, so a missing build is not an error.
 */
export const webApp: FastifyPluginAsync<WebAppOptions> = async (app, { webDistDir }) => {
  if (!existsSync(join(webDistDir, 'index.html'))) {
    app.log.info({ webDistDir }, 'web build not found; serve the issuer app with `pnpm dev`');
    return;
  }

  const hashedAssets = `${sep}assets${sep}`;
  await app.register(fastifyStatic, {
    root: webDistDir,
    prefix: '/',
    wildcard: false,
    index: false,
    setHeaders(reply, path) {
      reply.header(
        'cache-control',
        path.includes(hashedAssets) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });

  const serveSpa = (_request: unknown, reply: FastifyReply) =>
    reply.header('cache-control', 'no-cache').sendFile('index.html');
  for (const route of SPA_ROUTES) app.get(route, serveSpa);
};
