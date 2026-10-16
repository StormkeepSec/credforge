import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { VerifyResult } from '@credforge/contracts';
import { auditEvent, credential, eq } from '@credforge/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { type DocumentFetcher, FetchError } from '../../src/verify/fetch';
import { verifyAny } from '../../src/verify/service';
import { pngWithMetadata } from '../support/images';
import { createTestEnvironment, type TestEnvironment } from './support/harness';
import { awardTo, type IssuingOrg, issuingOrg, publishStatusLists } from './support/issuing';

const SAMPLE = resolve(import.meta.dirname, '../../../../packages/ob3/fixtures/sample');
const SAMPLE_BASE = 'https://credforge.app/ob3-sample';

/** Serves the ob3 sample issuer's documents, as its site would. */
const sampleFetcher: DocumentFetcher = async (url) => {
  if (!url.startsWith(`${SAMPLE_BASE}/`)) throw new FetchError('The site answered 404.');
  const rest = url.slice(SAMPLE_BASE.length + 1);
  if (rest.startsWith('credentials/')) {
    return {
      url,
      contentType: 'application/json',
      body: readFileSync(`${SAMPLE}/credential.json`),
    };
  }
  if (rest === 'badge.png') {
    return { url, contentType: 'image/png', body: readFileSync(`${SAMPLE}/badge.png`) };
  }
  return { url, contentType: 'application/json', body: readFileSync(`${SAMPLE}/public/${rest}`) };
};

let env: TestEnvironment;
let org: IssuingOrg;
let credentialId: string;
let credentialUrl: string;

/** A JSON request without cookies or an Origin header, as another site's server would send. */
async function verifyApi(app: FastifyInstance, body: unknown, contentType = 'application/json') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/verify',
    headers: { 'content-type': contentType },
    payload: Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
}

function multipart(
  fields: Record<string, string>,
  file?: { name: string; type: string; data: Buffer },
) {
  const boundary = `----credforge${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

beforeAll(async () => {
  env = await createTestEnvironment({ SIGNUP_MODE: 'open', VERIFY_RATE_LIMIT: '1000' });
  org = await issuingOrg(env);
  credentialId = await awardTo(org, { name: 'Ada Lovelace', email: 'ada@example.org' });
  credentialUrl = `${env.config.publicBaseUrl}/credentials/${credentialId}`;
});
afterAll(async () => {
  await env?.close();
});

describe('POST /api/v1/verify', () => {
  it('checks this instance’s credential by URL, each check on its own', async () => {
    const response = await verifyApi(env.app, { url: credentialUrl });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json() as VerifyResult;
    expect(result).toMatchObject({
      verified: true,
      source: 'url',
      credential: {
        id: credentialUrl,
        achievement: { name: 'Intro to Network Defense' },
        issuer: { name: 'Example Cyber Academy' },
        recipientName: 'Ada Lovelace',
        issuedHere: true,
      },
      checks: {
        format: { outcome: 'passed', message: 'Format and schema are valid' },
        proof: {
          outcome: 'passed',
          message: 'Signature checked with a key published by the issuer',
        },
        status: { outcome: 'passed' },
        validity: { outcome: 'passed' },
      },
    });
    expect(result.checks.status.message).toMatch(
      /^Not revoked \(status list checked at \d{4}-\d{2}-\d{2}T/,
    );
    expect(result.checks).not.toHaveProperty('recipient');
    expect(JSON.stringify(result)).not.toMatch(/guarantee/i);
  });

  it('checks pasted JSON, a baked image, and a raw image body', async () => {
    const [row] = await env.ownerDb
      .select()
      .from(credential)
      .where(eq(credential.id, credentialId));
    const asObject = (
      await verifyApi(env.app, { credential: row?.document })
    ).json() as VerifyResult;
    expect(asObject).toMatchObject({ verified: true, source: 'json' });
    const asText = (
      await verifyApi(env.app, { credential: JSON.stringify(row?.document) })
    ).json() as VerifyResult;
    expect(asText.verified).toBe(true);

    const png = (
      await env.app.inject({ method: 'GET', url: `/credentials/${credentialId}/badge.png` })
    ).rawPayload;
    const fromPng = (
      await verifyApi(env.app, { image: png.toString('base64') })
    ).json() as VerifyResult;
    expect(fromPng).toMatchObject({ verified: true, source: 'png' });
    const raw = (await verifyApi(env.app, png, 'image/png')).json() as VerifyResult;
    expect(raw).toMatchObject({ verified: true, source: 'png' });
    const svg = (
      await env.app.inject({ method: 'GET', url: `/credentials/${credentialId}/badge.svg` })
    ).rawPayload;
    const fromSvg = (
      await verifyApi(env.app, { image: `data:image/svg+xml;base64,${svg.toString('base64')}` })
    ).json() as VerifyResult;
    expect(fromSvg).toMatchObject({ verified: true, source: 'svg' });
  });

  it('checks an email address against the salted hash and stores nothing', async () => {
    const before = await env.ownerDb.select().from(auditEvent);
    const right = (
      await verifyApi(env.app, { url: credentialUrl, email: ' ADA@example.org ' })
    ).json() as VerifyResult;
    expect(right.checks.recipient).toEqual({
      outcome: 'passed',
      message: 'Issued to this email address (matched against the salted hash in the credential)',
    });
    const wrong = (
      await verifyApi(env.app, { url: credentialUrl, email: 'mallory@example.org' })
    ).json() as VerifyResult;
    expect(wrong.checks.recipient).toEqual({
      outcome: 'failed',
      message: 'Not issued to this email address',
    });
    // A wrong address doesn't make the credential itself fail.
    expect(wrong.verified).toBe(true);
    expect(await env.ownerDb.select().from(auditEvent)).toHaveLength(before.length);
  });

  it('fails the signature of a tampered credential and reports revocation', async () => {
    const [row] = await env.ownerDb
      .select()
      .from(credential)
      .where(eq(credential.id, credentialId));
    const tampered = { ...row?.document, name: 'Something else' };
    const result = (await verifyApi(env.app, { credential: tampered })).json() as VerifyResult;
    expect(result).toMatchObject({
      verified: false,
      checks: { proof: { outcome: 'failed', message: 'Signature check failed' } },
    });

    const revoked = await awardTo(org, { name: 'Revoked Person', email: 'revoked@example.org' });
    await org.owner.post(`${org.api}/credentials/${revoked}/revoke`, { reason: 'test' });
    const url = `${env.config.publicBaseUrl}/credentials/${revoked}`;
    const early = (await verifyApi(env.app, { url })).json() as VerifyResult;
    expect(early).toMatchObject({ verified: false, checks: { status: { outcome: 'failed' } } });
    await publishStatusLists(env);
    const later = (await verifyApi(env.app, { url })).json() as VerifyResult;
    expect(later.checks.status).toEqual({
      outcome: 'failed',
      message: 'The issuer has revoked this credential',
    });
  });

  it('says plainly when there is nothing to check', async () => {
    const cases: [unknown, RegExp][] = [
      [{ credential: 'not json' }, /isn’t a JSON credential/],
      [{ credential: 'eyJhbGciOiJFUzI1NiJ9.eyJ2YyI6e319.c2ln' }, /JWT-signed/],
      [
        { image: (await pngWithMetadata(64)).toString('base64') },
        /No Open Badges credential is baked into this PNG/,
      ],
      [{ image: Buffer.from('hello').toString('base64') }, /Upload a baked badge image/],
      [
        { url: `${env.config.publicBaseUrl}/credentials/${crypto.randomUUID()}` },
        /no public credential/,
      ],
      [{ url: 'https://127.0.0.1/credential.json' }, /isn’t a public address/],
      [{ url: 'not a url' }, /full address/],
    ];
    for (const [body, message] of cases) {
      const response = await verifyApi(env.app, body);
      expect(response.statusCode, JSON.stringify(body).slice(0, 60)).toBe(422);
      expect(response.json()).toMatchObject({
        code: 'not_a_credential',
        detail: expect.stringMatching(message),
      });
    }
    const none = await verifyApi(env.app, {});
    expect(none.statusCode).toBe(400);
    const two = await verifyApi(env.app, { url: credentialUrl, credential: '{}' });
    expect(two.statusCode).toBe(400);
  });

  it('treats a hidden credential as not there', async () => {
    const hidden = await awardTo(org, { name: 'Hidden Person', email: 'hidden@example.org' });
    await env.ownerDb
      .update(credential)
      .set({ visibility: 'hidden' })
      .where(eq(credential.id, hidden));
    const response = await verifyApi(env.app, {
      url: `${env.config.publicBaseUrl}/credentials/${hidden}`,
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('another issuer’s credential', () => {
  const services = () => ({
    db: env.db,
    publicBaseUrl: env.config.publicBaseUrl,
    fetcher: sampleFetcher,
  });
  const now = new Date('2026-10-15T12:00:00Z');

  it('fetches the issuer profile and status list from the issuer’s site', async () => {
    const result = await verifyAny(
      services(),
      { url: `${SAMPLE_BASE}/credentials/c0ffee00-1234-4abc-8def-0123456789ab` },
      now,
    );
    expect(result).toMatchObject({
      verified: true,
      credential: { issuedHere: false, issuer: { name: 'credforge sample issuer (test only)' } },
      checks: { proof: { outcome: 'passed' }, status: { outcome: 'passed' } },
    });
  });

  it('reads a baked image found at a URL, and reports a revoked sample', async () => {
    const fromImage = await verifyAny(services(), { url: `${SAMPLE_BASE}/badge.png` }, now);
    expect(fromImage).toMatchObject({ verified: true, source: 'png' });
    const revoked = await verifyAny(
      services(),
      { credential: readFileSync(`${SAMPLE}/credential-revoked.json`, 'utf8') },
      now,
    );
    expect(revoked).toMatchObject({
      verified: false,
      checks: {
        proof: { outcome: 'passed' },
        status: { outcome: 'failed', message: 'The issuer has revoked this credential' },
      },
    });
  });

  it('fails the signature check when the issuer’s profile can’t be loaded', async () => {
    const offline: DocumentFetcher = async () => {
      throw new FetchError('Couldn’t connect');
    };
    const result = await verifyAny(
      { ...services(), fetcher: offline },
      { credential: readFileSync(`${SAMPLE}/credential.json`, 'utf8') },
      now,
    );
    expect(result.checks.proof).toMatchObject({
      outcome: 'failed',
      message: expect.stringContaining('Could not load the issuer profile'),
    });
    expect(result.verified).toBe(false);
  });
});

describe('the /verify page', () => {
  it('shows the form, and checks a link straight away', async () => {
    const empty = await env.app.inject({
      method: 'GET',
      url: '/verify',
      headers: { accept: 'text/html' },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toContain('Check an Open Badges 3.0 credential');
    // HTML attribute names are case-insensitive; React writes this one as encType.
    expect(empty.body.toLowerCase()).toContain('enctype="multipart/form-data"');

    const linked = await env.app.inject({
      method: 'GET',
      url: `/verify?url=${encodeURIComponent(credentialUrl)}`,
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.body).toContain('Every check passed');
    expect(linked.body).toContain('Signature checked with a key published by the issuer');
    expect(linked.body).toContain('issued on this credforge site');
    expect(linked.headers['cache-control']).toBe('no-store');
  });

  it('checks an uploaded baked badge and an email address from the form', async () => {
    const png = (
      await env.app.inject({ method: 'GET', url: `/credentials/${credentialId}/badge.png` })
    ).rawPayload;
    const form = multipart(
      { url: '', json: '', email: 'ada@example.org' },
      { name: 'badge.png', type: 'image/png', data: png },
    );
    const response = await env.app.inject({ method: 'POST', url: '/verify', ...form });
    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
    expect(response.body).toContain('Every check passed');
    expect(response.body).toContain('Issued to this email address');
    // The address isn't shown back.
    expect(response.body).not.toContain('ada@example.org');
  });

  it('explains what went wrong', async () => {
    const none = await env.app.inject({
      method: 'POST',
      url: '/verify',
      ...multipart({ url: '', json: '' }),
    });
    expect(none.statusCode).toBe(400);
    expect(none.body).toContain('Nothing was checked');
    const bad = await env.app.inject({
      method: 'POST',
      url: '/verify',
      ...multipart({ json: '{"x":1' }),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.body).toContain('isn’t a JSON credential');
  });
});

describe('rate limits', () => {
  it('limits checks per client, on the page and the API together, but never status lists', async () => {
    const app = await buildApp({
      config: { ...env.config, verifyRateLimit: 3 },
      logger: false,
      checkDatabase: async () => {},
      services: {
        config: { ...env.config, verifyRateLimit: 3 },
        db: env.db,
        auth: env.auth,
        outbox: env.outbox,
        keys: env.keys,
        storage: env.storage,
      },
      verifyFetcher: sampleFetcher,
    });
    try {
      for (let i = 0; i < 2; i++)
        expect((await verifyApi(app, { url: credentialUrl })).statusCode).toBe(200);
      const page = await app.inject({
        method: 'GET',
        url: `/verify?url=${encodeURIComponent(credentialUrl)}`,
      });
      expect(page.statusCode).toBe(200);
      const limited = await verifyApi(app, { url: credentialUrl });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: 'rate_limited' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      const limitedPage = await app.inject({
        method: 'GET',
        url: `/verify?url=${encodeURIComponent(credentialUrl)}`,
      });
      expect(limitedPage.statusCode).toBe(429);
      expect(limitedPage.body).toContain('Too many checks');

      const [row] = await env.ownerDb
        .select()
        .from(credential)
        .where(eq(credential.id, credentialId));
      if (!row?.document) throw new Error('no credential');
      const { statusListCredential: listUrl } = row.document.credentialStatus as {
        statusListCredential: string;
      };
      for (let i = 0; i < 20; i++) {
        const list = await app.inject({
          method: 'GET',
          url: listUrl.replace(env.config.publicBaseUrl, ''),
        });
        expect(list.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
