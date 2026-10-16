import {
  apiKey,
  auditEvent,
  credential,
  eq,
  issuanceBatch,
  member,
  organization,
  user,
} from '@credforge/db';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueBatch } from '../../src/batches/service';
import { expectProblem, newUser } from './support/client';
import { createTestEnvironment, type TestEnvironment } from './support/harness';
import { type IssuingOrg, issuingOrg, workerServices } from './support/issuing';

/** API keys (design plan §10, §12): shown once, hashed, scoped, revocable, rate limited. */

let env: TestEnvironment;
let org: IssuingOrg;

beforeAll(async () => {
  env = await createTestEnvironment({ SIGNUP_MODE: 'open', API_RATE_LIMIT: '1000' });
  org = await issuingOrg(env);
});
afterAll(async () => {
  await env?.close();
});

/** A request as an integration makes it: the key, no cookies, no Origin header. */
function withKey(
  key: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return env.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { payload: JSON.stringify(body) }),
  });
}

async function createKey(scopes: string[], extra: Record<string, unknown> = {}) {
  const response = await org.owner.post(`${org.api}/api-keys`, {
    name: 'LMS integration',
    scopes,
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string; key: string; prefix: string };
}

describe('creating and listing keys', () => {
  it('shows the key once and stores only its hash', async () => {
    const created = await createKey(['achievement:read', 'credential:read', 'credential:issue']);
    expect(created.key).toMatch(/^cf_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(created.key.startsWith(`${created.prefix}_`)).toBe(true);

    const [row] = await env.ownerDb.select().from(apiKey).where(eq(apiKey.id, created.id));
    expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(created.key);

    const listed = await org.owner.get(`${org.api}/api-keys`);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(created.key);
    expect(listed.json()).toMatchObject({
      apiKeys: expect.arrayContaining([
        expect.objectContaining({ id: created.id, prefix: created.prefix, revokedAt: null }),
      ]),
    });

    const [event] = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.targetId, created.id));
    expect(event).toMatchObject({ action: 'api_key.created', orgId: org.orgId });
    expect(JSON.stringify(event?.data)).not.toContain(created.key);
  });

  it('refuses scopes a key can never have, and members who may not manage keys', async () => {
    const bad = await org.owner.post(`${org.api}/api-keys`, {
      name: 'Too much',
      scopes: ['member:manage'],
    });
    expectProblem(bad, 400, 'validation_failed');

    const issuer = await newUser(env, { twoFactor: false });
    const [row] = await env.ownerDb
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, issuer.email));
    await env.ownerDb
      .insert(member)
      .values({ orgId: org.orgId, userId: row?.id ?? '', role: 'issuer' });
    expectProblem(await issuer.get(`${org.api}/api-keys`), 403, 'forbidden');
    expectProblem(
      await issuer.post(`${org.api}/api-keys`, { name: 'Mine', scopes: ['credential:read'] }),
      403,
      'forbidden',
    );
  });
});

describe('using a key', () => {
  it('awards a badge without cookies or an Origin header, and records the key as the actor', async () => {
    const { key, id, prefix } = await createKey([
      'achievement:read',
      'credential:read',
      'credential:issue',
    ]);
    const achievements = await withKey(key, 'GET', `${org.api}/achievements`);
    expect(achievements.statusCode).toBe(200);

    const awarded = await withKey(key, 'POST', `${org.api}/credentials`, {
      achievementId: org.achievementId,
      recipient: { name: 'Sam Lee', email: 'sam@example.org' },
    });
    expect(awarded.statusCode, awarded.body).toBe(201);
    const body = awarded.json() as { id: string; issuedBy: { type: string; label: string } };
    expect(body.issuedBy).toEqual({ type: 'api_key', id, label: `LMS integration (${prefix})` });

    const [row] = await env.ownerDb.select().from(credential).where(eq(credential.id, body.id));
    expect(row).toMatchObject({ issuedByType: 'api_key', issuedById: id });
    const [event] = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.targetId, body.id));
    expect(event).toMatchObject({ actorType: 'api_key', actorId: id, action: 'credential.issued' });

    const [used] = await env.ownerDb.select().from(apiKey).where(eq(apiKey.id, id));
    expect(used?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('holds only the scopes it was given', async () => {
    const { key } = await createKey(['credential:read']);
    expect((await withKey(key, 'GET', `${org.api}/credentials`)).statusCode).toBe(200);
    expectProblem(
      await withKey(key, 'POST', `${org.api}/credentials`, {
        achievementId: org.achievementId,
        recipient: { name: 'Sam Lee', email: 'sam@example.org' },
      }),
      403,
      'forbidden',
    );
    expectProblem(await withKey(key, 'GET', `${org.api}/achievements`), 403, 'forbidden');
  });

  it('never reaches what needs a person: members, keys, the org, the account', async () => {
    const { key } = await createKey([
      'issuer:read',
      'achievement:read',
      'achievement:write',
      'credential:read',
      'credential:issue',
      'credential:revoke',
      'credential:export',
      'audit:read',
    ]);
    for (const [method, url] of [
      ['GET', org.api],
      ['GET', `${org.api}/members`],
      ['GET', `${org.api}/invitations`],
      ['GET', `${org.api}/api-keys`],
      ['POST', `${org.api}/api-keys`],
      ['PATCH', `${org.api}/issuers/${org.issuerId}`],
      ['POST', `${org.api}/issuers/${org.issuerId}/domain-verification`],
    ] as const) {
      const response = await withKey(key, method, url, method === 'GET' ? undefined : {});
      expectProblem(response, 403, 'api_key_not_allowed');
    }
    expectProblem(await withKey(key, 'GET', '/api/v1/me'), 401, 'unauthenticated');
    expectProblem(
      await withKey(key, 'POST', '/api/v1/orgs', { name: 'Made by a key' }),
      401,
      'unauthenticated',
    );
  });

  it('ignores cookies when a key is sent, so a bad key never falls back to the session', async () => {
    const response = await org.owner.request('GET', `${org.api}/credentials`, undefined, {
      authorization: 'Bearer cf_000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expectProblem(response, 401, 'unauthenticated');
    const notAKey = await org.owner.request('GET', '/api/v1/me', undefined, {
      authorization: 'Bearer something-else',
    });
    expectProblem(notAKey, 401, 'unauthenticated');
  });

  it('refuses unknown, malformed, revoked and expired keys', async () => {
    const { key, id } = await createKey(['credential:read']);
    const url = `${org.api}/credentials`;
    expectProblem(await withKey(`${key}x`, 'GET', url), 401, 'unauthenticated');
    expectProblem(await withKey('not-a-key', 'GET', url), 401, 'unauthenticated');

    const revoked = await org.owner.delete(`${org.api}/api-keys/${id}`);
    expect(revoked.statusCode).toBe(204);
    expectProblem(await withKey(key, 'GET', url), 401, 'unauthenticated');
    const [event] = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, 'api_key.revoked'));
    expect(event).toMatchObject({ targetId: id, orgId: org.orgId });
    // Revoking again is fine; the key stays listed as revoked.
    expect((await org.owner.delete(`${org.api}/api-keys/${id}`)).statusCode).toBe(204);

    const expiring = await createKey(['credential:read'], { expiresInDays: 1 });
    expect((await withKey(expiring.key, 'GET', url)).statusCode).toBe(200);
    await env.ownerDb
      .update(apiKey)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKey.id, expiring.id));
    expectProblem(await withKey(expiring.key, 'GET', url), 401, 'unauthenticated');
  });

  it('confirms a batch that the worker then awards as the key', async () => {
    const { key, id } = await createKey(['credential:read', 'credential:issue']);
    const created = await withKey(key, 'POST', `${org.api}/batches`, {
      achievementId: org.achievementId,
      rows: [{ name: 'Ada Byron', email: 'ada@example.org' }],
      sendEmail: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const batchId = (created.json() as { id: string }).id;
    const confirmed = await withKey(key, 'POST', `${org.api}/batches/${batchId}/confirm`);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const [batch] = await env.ownerDb
      .select()
      .from(issuanceBatch)
      .where(eq(issuanceBatch.id, batchId));
    expect(batch).toMatchObject({
      createdByType: 'api_key',
      confirmedByType: 'api_key',
      confirmedById: id,
    });
    expect(await issueBatch(workerServices(env), batchId)).toBe('done');
    const [awarded] = await env.ownerDb
      .select()
      .from(credential)
      .where(eq(credential.batchId, batchId));
    expect(awarded).toMatchObject({ issuedByType: 'api_key', issuedById: id });
    const details = await withKey(key, 'GET', `${org.api}/batches/${batchId}`);
    expect(details.json()).toMatchObject({
      createdBy: { type: 'api_key', id, label: expect.stringContaining('LMS integration') },
    });
  });

  it('can read but not change anything while the org is suspended', async () => {
    const { key } = await createKey(['credential:read', 'credential:issue']);
    await env.ownerDb
      .update(organization)
      .set({ status: 'suspended' })
      .where(eq(organization.id, org.orgId));
    try {
      expect((await withKey(key, 'GET', `${org.api}/credentials`)).statusCode).toBe(200);
      expectProblem(
        await withKey(key, 'POST', `${org.api}/credentials`, {
          achievementId: org.achievementId,
          recipient: { name: 'Sam Lee', email: 'sam@example.org' },
        }),
        403,
        'org_inactive',
      );
    } finally {
      await env.ownerDb
        .update(organization)
        .set({ status: 'active' })
        .where(eq(organization.id, org.orgId));
    }
  });
});

describe('rate limit per key', () => {
  let limited: TestEnvironment;
  let limitedOrg: IssuingOrg;

  beforeAll(async () => {
    limited = await createTestEnvironment({ SIGNUP_MODE: 'open', API_RATE_LIMIT: '3' });
    limitedOrg = await issuingOrg(limited);
  });
  afterAll(async () => {
    await limited?.close();
  });

  it('answers 429 with Retry-After once a key passes its limit, without slowing other keys', async () => {
    const make = async () =>
      (
        (
          await limitedOrg.owner.post(`${limitedOrg.api}/api-keys`, {
            name: 'Busy',
            scopes: ['credential:read'],
          })
        ).json() as { key: string }
      ).key;
    const [first, second] = [await make(), await make()];
    const call = (key: string) =>
      limited.app.inject({
        method: 'GET',
        url: `${limitedOrg.api}/credentials`,
        headers: { authorization: `Bearer ${key}` },
      });
    for (let i = 0; i < 3; i++) expect((await call(first)).statusCode).toBe(200);
    const over = await call(first);
    expectProblem(over, 429, 'rate_limited');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await call(second)).statusCode).toBe(200);
    // The issuer app's own session isn't limited per key.
    expect((await limitedOrg.owner.get(`${limitedOrg.api}/credentials`)).statusCode).toBe(200);
  });
});
