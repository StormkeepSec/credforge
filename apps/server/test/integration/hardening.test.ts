import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS, openApiPath } from '../../src/api/operations';
import { expectProblem, lastEmailTo, linkIn } from './support/client';
import { BASE_URL, createTestEnvironment, type TestEnvironment } from './support/harness';
import { awardTo, type IssuingOrg, issuingOrg } from './support/issuing';

/**
 * Production hardening (M5, design plan §6.3, §12): headers, the API's documentation and its
 * coverage of every route, rate limits on links, sign-in and the webhook (never on /status/),
 * "Report a problem", and the landing, privacy and terms pages.
 */

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '../fixtures/sendgrid/signature.json'), 'utf8'),
) as { publicKey: string };

let env: TestEnvironment;
let org: IssuingOrg;
let credentialId: string;
let claimLink: string;

beforeAll(async () => {
  env = await createTestEnvironment({
    SIGNUP_MODE: 'open',
    CLAIM_RATE_LIMIT: '2',
    VERIFY_RATE_LIMIT: '1',
    ABUSE_EMAIL: 'abuse@credforge.test',
    SECURITY_EMAIL: 'security@credforge.test',
    PRIVACY_EMAIL: 'privacy@credforge.test',
    SENDGRID_WEBHOOK_PUBLIC_KEY: fixture.publicKey,
  });
  org = await issuingOrg(env);
  credentialId = await awardTo(org, { name: 'Jordan Rivera', email: org.owner.email });
  claimLink = linkIn(lastEmailTo(env, org.owner.email, 'award').text, /https:\/\/\S+\?t=\S+/);
});
afterAll(async () => {
  await env?.close();
});

const html = (url: string) =>
  env.app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });

describe('headers', () => {
  it('sends a strict CSP, no framing, and a Permissions-Policy on pages', async () => {
    for (const url of [
      '/',
      `/credentials/${credentialId}`,
      `/issuers/${org.issuerId}`,
      '/verify',
    ]) {
      const response = await html(url);
      expect(response.statusCode, url).toBe(200);
      const csp = String(response.headers['content-security-policy']);
      expect(csp, url).toContain("script-src 'self'");
      expect(csp, url).toContain("frame-ancestors 'none'");
      expect(csp, url).not.toContain('unsafe-inline');
      expect(response.headers['x-frame-options'], url).toBe('DENY');
      expect(response.headers['permissions-policy'], url).toContain('camera=()');
      expect(response.headers['referrer-policy'], url).toBe('same-origin');
      expect(response.headers['strict-transport-security'], url).toContain('max-age=31536000');
      expect(response.headers['x-content-type-options'], url).toBe('nosniff');
    }
  });
});

describe('API documentation', () => {
  it('documents every /api/v1 route, and nothing that does not exist', () => {
    const registered = new Set(
      env.routes
        .filter(
          (route) =>
            route.url.startsWith('/api/v1/') &&
            route.method !== 'HEAD' &&
            route.url !== '/api/v1/openapi.json',
        )
        .map((route) => `${route.method} ${openApiPath(route.url)}`),
    );
    const documented = OPERATIONS.map((op) => `${op.method} ${op.path}`);
    expect(new Set(documented).size).toBe(documented.length);
    expect([...registered].sort()).toEqual([...documented].sort());
  });

  it('serves the OpenAPI document and the interactive docs from this origin', async () => {
    const spec = await env.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(spec.statusCode).toBe(200);
    const document = spec.json() as {
      openapi: string;
      servers: { url: string }[];
      paths: Record<string, Record<string, { security: unknown[] }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.openapi).toBe('3.1.0');
    expect(document.servers[0]?.url).toBe(`${BASE_URL}/api/v1`);
    expect(document.paths['/orgs/{orgId}/credentials']?.post?.security).toEqual([
      { apiKey: [] },
      { session: [] },
    ]);
    expect(document.paths['/orgs/{orgId}/members']?.get?.security).toEqual([{ session: [] }]);
    // Every $ref points at a component that exists.
    for (const ref of spec.body.match(/#\/components\/schemas\/[\w.-]+/g) ?? []) {
      expect(document.components.schemas, ref).toHaveProperty(ref.split('/').pop() as string);
    }

    const docs = await html('/api/docs');
    expect(docs.statusCode).toBe(200);
    expect(docs.body).toContain('/api/docs/assets/swagger-ui-bundle.js');
    expect(docs.body).not.toMatch(/<script>|<script [^s]/);
    expect(String(docs.headers['content-security-policy'])).toContain("script-src 'self'");
    for (const asset of ['swagger-ui-bundle.js', 'swagger-ui.css', 'init.js', 'docs.css']) {
      const response = await env.app.inject({ method: 'GET', url: `/api/docs/assets/${asset}` });
      expect(response.statusCode, asset).toBe(200);
    }
    const other = await env.app.inject({ method: 'GET', url: '/api/docs/assets/package.json' });
    expect(other.statusCode).toBe(404);
  });
});

describe('rate limits', () => {
  it('limits claim links per client IP, but never status lists', async () => {
    const path = new URL(claimLink).pathname + new URL(claimLink).search;
    expect((await html(path)).statusCode).toBe(303);
    expect((await html(`/credentials/${credentialId}?t=wrong`)).statusCode).toBe(303);
    const limited = await html(path);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body).toContain('Too many requests');
    // The page itself, without a token, isn't limited.
    expect((await html(`/credentials/${credentialId}`)).statusCode).toBe(200);

    const document = (
      await env.app.inject({
        method: 'GET',
        url: `/credentials/${credentialId}`,
        headers: { accept: 'application/json' },
      })
    ).json() as { credentialStatus: { statusListCredential: string } };
    const statusPath = new URL(document.credentialStatus.statusListCredential).pathname;
    for (let i = 0; i < 25; i++) {
      const response = await env.app.inject({ method: 'GET', url: statusPath });
      expect(response.statusCode).toBe(200);
    }
  });

  it('limits invitation links per client IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (await env.app.inject({ method: 'GET', url: '/api/v1/invitations/not-a-real-token' }))
          .statusCode,
      );
    }
    expect(statuses.slice(0, 2)).not.toContain(429);
    expect(statuses[2]).toBe(429);
  });

  it('turns away a client that keeps sending bad webhook signatures', async () => {
    const send = () =>
      env.app.inject({
        method: 'POST',
        url: '/api/webhooks/sendgrid',
        headers: { 'content-type': 'application/json' },
        payload: '[]',
      });
    for (let i = 0; i < 20; i++) expect((await send()).statusCode).toBe(403);
    expect((await send()).statusCode).toBe(429);
  });
});

describe('sign-in rate limits', () => {
  let limited: TestEnvironment;

  beforeAll(async () => {
    limited = await createTestEnvironment({ SIGNUP_MODE: 'open', AUTH_RATE_LIMIT: 'true' });
  });
  afterAll(async () => {
    await limited?.close();
  });

  it('limits password guesses per client IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const response = await limited.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: BASE_URL, 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'nobody@example.org', password: `guess-${i}-guess` }),
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('abuse reports and public pages', () => {
  it('puts the "Report a problem" form on badge, achievement and issuer pages, with the abuse address', async () => {
    for (const [url, action] of [
      [`/credentials/${credentialId}`, `/report/credential/${credentialId}`],
      [`/achievements/${org.achievementId}`, `/report/achievement/${org.achievementId}`],
      [`/issuers/${org.issuerId}`, `/report/issuer/${org.issuerId}`],
    ] as const) {
      const body = (await html(url)).body;
      expect(body, url).toContain('Report a problem');
      expect(body, url).toContain(`action="${action}"`);
      expect(body, url).toContain('value="child_safety"');
      expect(body, url).toContain('href="mailto:abuse@credforge.test"');
    }
  });

  it('keeps the report form without an abuse address, and no security.txt without its address', async () => {
    const plain = await createTestEnvironment({ SIGNUP_MODE: 'open' });
    try {
      const plainOrg = await issuingOrg(plain);
      const page = await plain.app.inject({
        method: 'GET',
        url: `/issuers/${plainOrg.issuerId}`,
        headers: { accept: 'text/html' },
      });
      expect(page.body).toContain('Report a problem');
      expect(page.body).not.toContain('mailto:abuse@');
      const security = await plain.app.inject({
        method: 'GET',
        url: '/.well-known/security.txt',
      });
      expect(security.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it('serves the landing page, the draft privacy policy and terms, and security.txt', async () => {
    const landing = await html('/');
    expect(landing.body).toContain('Achievement deserves more than a moment.');
    expect(landing.body).toContain('href="/privacy"');
    expect(landing.body).not.toMatch(/certified/i);

    const privacy = await html('/privacy');
    expect(privacy.statusCode).toBe(200);
    expect(privacy.body).toContain('Draft for review: not in effect yet');
    expect(privacy.body).toContain('mailto:privacy@credforge.test');
    expect(privacy.body).toContain('salted hash');

    const terms = await html('/terms');
    expect(terms.statusCode).toBe(200);
    expect(terms.body).toContain('Terms of service');
    expect(terms.body).toContain('mailto:abuse@credforge.test');

    const security = await env.app.inject({ method: 'GET', url: '/.well-known/security.txt' });
    expect(security.statusCode).toBe(200);
    expect(security.body).toContain('Contact: mailto:security@credforge.test');
    expect(security.body).toMatch(/Expires: \d{4}-\d{2}-\d{2}T/);
  });

  it("doesn't let the verify limiter touch the API key routes or vice versa", async () => {
    const first = await env.app.inject({
      method: 'POST',
      url: '/api/v1/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ url: `${BASE_URL}/credentials/${credentialId}` }),
    });
    expect(first.statusCode).toBe(200);
    expectProblem(
      await env.app.inject({
        method: 'POST',
        url: '/api/v1/verify',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ url: `${BASE_URL}/credentials/${credentialId}` }),
      }),
      429,
      'rate_limited',
    );
    expect((await org.owner.get(`${org.api}/credentials`)).statusCode).toBe(200);
  });
});
