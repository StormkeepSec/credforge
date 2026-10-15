import { auditEvent, eq, signingKey } from '@credforge/db';
import {
  type IssuerProfileDocument,
  issueCredential,
  validateProfileSchema,
  verifyCredential,
} from '@credforge/ob3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signingKeyAad } from '../../src/crypto/key-encryption';
import { loadSigner } from '../../src/issuers/service';
import { expectProblem, lastEmailTo, linkIn, newUser, TestClient } from './support/client';
import { BASE_URL, createTestEnvironment, type TestEnvironment } from './support/harness';

let env: TestEnvironment;
let owner: TestClient;
let orgId: string;

interface IssuerBody {
  id: string;
  url: string;
  name: string;
  website: string | null;
  keys: { id: string; publicKeyMultibase: string; status: string }[];
}

beforeAll(async () => {
  env = await createTestEnvironment({ SIGNUP_MODE: 'approval' });
  owner = await newUser(env);
  orgId = (
    (await owner.post('/api/v1/orgs', { name: 'Example Cyber Academy' })).json() as { id: string }
  ).id;
});
afterAll(async () => {
  await env?.close();
});

async function createIssuer(body: Record<string, unknown> = {}) {
  const response = await owner.post(`/api/v1/orgs/${orgId}/issuers`, {
    name: 'Example Cyber Academy',
    url: 'https://example.org',
    email: 'badges@example.org',
    description: 'Hands-on security training.',
    ...body,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as IssuerBody;
}

describe('issuer profiles', () => {
  it('creates an issuer with an Ed25519 key, the private key encrypted', async () => {
    const created = await createIssuer();
    expect(created).toMatchObject({
      url: `${BASE_URL}/issuers/${created.id}`,
      name: 'Example Cyber Academy',
      website: 'https://example.org',
    });
    expect(created.keys).toEqual([
      expect.objectContaining({
        algorithm: 'Ed25519',
        status: 'active',
        publicKeyMultibase: expect.stringMatching(/^z6Mk/),
      }),
    ]);
    expect(JSON.stringify(created)).not.toMatch(/z3u2|secret|encrypted/i);

    const [stored] = await env.ownerDb
      .select()
      .from(signingKey)
      .where(eq(signingKey.issuerId, created.id));
    expect(stored).toMatchObject({ kekVersion: 1, orgId, status: 'active' });
    expect(stored?.encryptedPrivateKey).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(stored?.encryptedPrivateKey).not.toContain('z3u2');
    // Bound to its row: the same ciphertext under another key id doesn't decrypt.
    if (!stored) throw new Error('no key');
    expect(env.keys.decrypt(stored.encryptedPrivateKey, signingKeyAad(stored.id), 1)).toMatch(
      /^z3u2/,
    );
    expect(() =>
      env.keys.decrypt(stored.encryptedPrivateKey, signingKeyAad(crypto.randomUUID()), 1),
    ).toThrow();
  });

  it('validates input', async () => {
    const response = await owner.post(`/api/v1/orgs/${orgId}/issuers`, {
      name: '',
      url: 'not a url',
      email: 'nope',
    });
    expectProblem(response, 400, 'validation_failed');
    expect(Object.keys((response.json() as { errors: object }).errors).sort()).toEqual([
      'email',
      'name',
      'url',
    ]);
  });

  it('updates the profile and records what changed', async () => {
    const created = await createIssuer({ name: 'Before' });
    const updated = await owner.patch(`/api/v1/orgs/${orgId}/issuers/${created.id}`, {
      name: 'After',
      url: '',
    });
    expect(updated.json()).toMatchObject({ name: 'After', website: null });
    const events = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.targetId, created.id));
    expect(events.map((event) => event.action)).toEqual(['issuer.created', 'issuer.updated']);
    expect(events[1]?.data).toEqual({
      name: { from: 'Before', to: 'After' },
      url: { from: 'https://example.org', to: null },
    });
  });

  it('lets only owners and admins change it', async () => {
    const created = await createIssuer();
    const viewer = await newUser(env, { twoFactor: false });
    await owner.post(`/api/v1/orgs/${orgId}/invitations`, { email: viewer.email, role: 'issuer' });
    const token = linkIn(lastEmailTo(env, viewer.email, 'invitation').text, /\/invite\/[\w-]+/)
      .split('/')
      .pop();
    await viewer.post(`/api/v1/invitations/${token}/accept`);
    expect((await viewer.get(`/api/v1/orgs/${orgId}/issuers/${created.id}`)).statusCode).toBe(200);
    expectProblem(
      await viewer.patch(`/api/v1/orgs/${orgId}/issuers/${created.id}`, { name: 'x' }),
      403,
      'forbidden',
    );
  });
});

describe('public issuer URL', () => {
  let created: IssuerBody;
  beforeAll(async () => {
    created = await createIssuer();
  });

  const anonymous = () => new TestClient(env, '', '');

  it('serves the OB Profile and controller document as JSON', async () => {
    for (const accept of [undefined, '*/*', 'application/json']) {
      const response = await anonymous().get(`/issuers/${created.id}`, accept ? { accept } : {});
      expect(response.statusCode, accept).toBe(200);
      expect(response.headers['content-type'], accept).toBe('application/json; charset=utf-8');
      expect(response.headers.vary).toContain('Accept');
      expect(response.headers['access-control-allow-origin']).toBe('*');
    }
    const response = await anonymous().get(`/issuers/${created.id}`, {
      accept: 'application/ld+json',
    });
    expect(response.headers['content-type']).toBe('application/ld+json; charset=utf-8');
    const profile = response.json() as IssuerProfileDocument;
    const key = created.keys[0]?.publicKeyMultibase;
    expect(profile).toMatchObject({
      '@context': [
        'https://www.w3.org/ns/credentials/v2',
        'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json',
        'https://www.w3.org/ns/cid/v1',
      ],
      id: created.url,
      type: ['Profile'],
      name: 'Example Cyber Academy',
      url: 'https://example.org',
      email: 'badges@example.org',
      verificationMethod: [
        {
          id: `${created.url}#${key}`,
          type: 'Multikey',
          controller: created.url,
          publicKeyMultibase: key,
        },
      ],
      assertionMethod: [`${created.url}#${key}`],
    });
    expect(validateProfileSchema(profile)).toEqual({ valid: true, errors: [] });
  });

  it('serves an HTML page to browsers', async () => {
    const response = await anonymous().get(`/issuers/${created.id}`, {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('Example Cyber Academy');
    expect(response.body).toContain('Website (self-reported)');
    expect(response.body).toContain('Not reviewed yet'); // the org is still pending
    expect(response.body).toContain(
      `<link rel="alternate" type="application/ld+json" href="${created.url}"/>`,
    );
  });

  it('is a 404 for unknown or malformed ids', async () => {
    expect((await anonymous().get(`/issuers/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect((await anonymous().get('/issuers/nope', { accept: 'text/html' })).body).toContain(
      'Page not found',
    );
  });

  it('refuses types it does not have', async () => {
    expect(
      (await anonymous().get(`/issuers/${created.id}`, { accept: 'image/png' })).statusCode,
    ).toBe(406);
  });

  it('verifies a credential signed with the stored key (ready for M3)', async () => {
    const [key] = await env.ownerDb
      .select()
      .from(signingKey)
      .where(eq(signingKey.issuerId, created.id));
    if (!key) throw new Error('no key');
    const signer = await loadSigner(env.keys, BASE_URL, key);
    const fetchProfile = async (id: string) => {
      const response = await anonymous().get(new URL(id).pathname, {
        accept: 'application/ld+json',
      });
      return response.json();
    };
    const issuerProfile = (await fetchProfile(created.url)) as IssuerProfileDocument;
    const credential = await issueCredential(
      {
        id: `${BASE_URL}/credentials/${crypto.randomUUID()}`,
        issuer: { id: created.url, name: 'Example Cyber Academy', url: 'https://example.org' },
        achievement: {
          id: `${BASE_URL}/achievements/${crypto.randomUUID()}`,
          name: 'Intro to Network Defense',
          description: 'Foundational skills in defending small networks.',
          criteria: { narrative: 'Completed all six labs.' },
        },
        recipient: { email: 'jordan@example.org', name: 'Jordan Rivera' },
        validFrom: new Date(),
      },
      { signer, issuerProfile },
    );
    const result = await verifyCredential(credential, { resolveController: fetchProfile });
    expect(result.verified).toBe(true);
  });
});
