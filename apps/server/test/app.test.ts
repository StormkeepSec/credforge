import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App | undefined;

async function makeApp(options: { databaseUp?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'https://credforge.test',
    DATABASE_URL: 'postgres://unused',
    // An empty directory: no web build, like a fresh checkout.
    WEB_DIST_DIR: mkdtempSync(join(tmpdir(), 'credforge-web-')),
    ...options.env,
  });
  app = await buildApp({
    config,
    logger: false,
    checkDatabase: async () => {
      if (options.databaseUp === false) throw new Error('connection refused');
    },
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health', () => {
  it('reports liveness', async () => {
    const res = await (await makeApp()).inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness when the database answers', async () => {
    const res = await (await makeApp()).inject({ url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });

  it('returns 503 when the database is down', async () => {
    const res = await (await makeApp({ databaseUp: false })).inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable', checks: { database: 'error' } });
  });
});

describe('landing page', () => {
  it('renders the branded page with security headers', async () => {
    const res = await (await makeApp()).inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toMatch(/^<!doctype html>/);
    expect(res.body).toContain('Achievement deserves more than a moment.');
    expect(res.body).toContain('<link rel="canonical" href="https://credforge.test/"/>');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
  });

  it('redirects to sign-in when the landing page is disabled', async () => {
    const res = await (await makeApp({ env: { LANDING_PAGE: 'false' } })).inject({ url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('not found', () => {
  it('serves an HTML page to browsers', async () => {
    const res = await (await makeApp()).inject({
      url: '/nope',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Page not found');
  });

  it('serves JSON to API clients', async () => {
    const res = await (await makeApp()).inject({
      url: '/api/v1/nope',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
  });
});

describe('request ids', () => {
  it('echoes a well-formed X-Request-Id', async () => {
    const res = await (await makeApp()).inject({
      url: '/healthz',
      headers: { 'x-request-id': 'nginx-req-12345678' },
    });
    expect(res.headers['x-request-id']).toBe('nginx-req-12345678');
  });

  it('replaces a malformed one', async () => {
    const res = await (await makeApp()).inject({
      url: '/healthz',
      headers: { 'x-request-id': 'has spaces <script>' },
    });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
