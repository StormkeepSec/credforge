import {
  achievement,
  auditEvent,
  eq,
  file,
  invitation,
  issuer,
  member,
  organization,
} from '@credforge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pngWithMetadata } from '../support/images';
import { lastEmailTo, linkIn, newUser, type TestClient } from './support/client';
import { createTestEnvironment, type TestEnvironment } from './support/harness';

/**
 * Tenant isolation (design plan §7): a member of org A, with every permission there, tries to
 * reach org B's data through every org-scoped endpoint. The route list comes from the app
 * itself, so a new org-scoped endpoint without a case here fails the coverage test.
 */

let env: TestEnvironment;

interface Tenant {
  owner: TestClient;
  orgId: string;
  issuerId: string;
  memberId: string;
  invitationId: string;
  achievementId: string;
}

let png: Buffer;

let a: Tenant;
let b: Tenant;

async function tenant(name: string): Promise<Tenant> {
  const owner = await newUser(env);
  const org = await owner.post('/api/v1/orgs', { name });
  const orgId = (org.json() as { id: string }).id;
  const created = await owner.post(`/api/v1/orgs/${orgId}/issuers`, {
    name: `${name} Issuer`,
    url: 'https://example.org',
  });
  const issuerId = (created.json() as { id: string }).id;

  const colleague = await newUser(env, { twoFactor: false });
  await owner.post(`/api/v1/orgs/${orgId}/invitations`, { email: colleague.email, role: 'viewer' });
  const token = linkIn(lastEmailTo(env, colleague.email, 'invitation').text, /\/invite\/\S+/)
    .split('/')
    .pop();
  await colleague.post(`/api/v1/invitations/${token}/accept`);
  const members = (await owner.get(`/api/v1/orgs/${orgId}/members`)).json() as {
    members: { id: string; email: string }[];
  };
  const memberId = members.members.find((row) => row.email === colleague.email)?.id;
  if (!memberId) throw new Error('Colleague did not join.');

  const invited = await owner.post(`/api/v1/orgs/${orgId}/invitations`, {
    email: `pending-${name.toLowerCase().replace(/\W/g, '')}@example.org`,
    role: 'issuer',
  });
  const invitationId = (invited.json() as { id: string }).id;

  const draft = await owner.post(`/api/v1/orgs/${orgId}/achievements`, {
    name: `${name} Badge`,
    description: 'A badge.',
    criteriaNarrative: 'Earn it.',
  });
  const achievementId = (draft.json() as { id: string }).id;
  await owner.upload(`/api/v1/orgs/${orgId}/achievements/${achievementId}/image`, png, 'image/png');
  await owner.post(`/api/v1/orgs/${orgId}/achievements/${achievementId}/publish`);
  await owner.upload(`/api/v1/orgs/${orgId}/issuers/${issuerId}/logo`, png, 'image/png');
  return { owner, orgId, issuerId, memberId, invitationId, achievementId };
}

beforeAll(async () => {
  env = await createTestEnvironment({ SIGNUP_MODE: 'open' });
  png = await pngWithMetadata(200);
  a = await tenant('Alpha');
  b = await tenant('Bravo');
});
afterAll(async () => {
  await env?.close();
});

interface Case {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Route pattern as registered, relative to /api/v1/orgs/:orgId. */
  route: string;
  body?: unknown;
  /** Has an id of a resource inside the org. */
  resource?: 'memberId' | 'invitationId' | 'issuerId' | 'achievementId';
  /** Sends an image file as the body (uploads). */
  upload?: true;
}

const CASES: Case[] = [
  { method: 'GET', route: '' },
  { method: 'PATCH', route: '', body: { name: 'Taken over' } },
  { method: 'GET', route: '/members' },
  { method: 'PATCH', route: '/members/:memberId', resource: 'memberId', body: { role: 'admin' } },
  { method: 'DELETE', route: '/members/:memberId', resource: 'memberId' },
  { method: 'GET', route: '/invitations' },
  { method: 'POST', route: '/invitations', body: { email: 'intruder@example.org', role: 'owner' } },
  { method: 'POST', route: '/invitations/:invitationId/resend', resource: 'invitationId' },
  { method: 'DELETE', route: '/invitations/:invitationId', resource: 'invitationId' },
  { method: 'GET', route: '/issuers' },
  { method: 'POST', route: '/issuers', body: { name: 'Intruder issuer' } },
  { method: 'GET', route: '/issuers/:issuerId', resource: 'issuerId' },
  {
    method: 'PATCH',
    route: '/issuers/:issuerId',
    resource: 'issuerId',
    body: { name: 'Hijacked' },
  },
  { method: 'GET', route: '/audit-events' },
  { method: 'PUT', route: '/issuers/:issuerId/logo', resource: 'issuerId', upload: true },
  { method: 'DELETE', route: '/issuers/:issuerId/logo', resource: 'issuerId' },
  { method: 'GET', route: '/achievements' },
  {
    method: 'POST',
    route: '/achievements',
    body: { name: 'Intruder', description: 'x', criteriaNarrative: 'x' },
  },
  { method: 'GET', route: '/achievements/:achievementId', resource: 'achievementId' },
  {
    method: 'PATCH',
    route: '/achievements/:achievementId',
    resource: 'achievementId',
    body: { name: 'Hijacked' },
  },
  { method: 'DELETE', route: '/achievements/:achievementId', resource: 'achievementId' },
  {
    method: 'PUT',
    route: '/achievements/:achievementId/image',
    resource: 'achievementId',
    upload: true,
  },
  { method: 'POST', route: '/achievements/:achievementId/publish', resource: 'achievementId' },
  { method: 'POST', route: '/achievements/:achievementId/archive', resource: 'achievementId' },
  { method: 'POST', route: '/achievements/:achievementId/restore', resource: 'achievementId' },
  { method: 'GET', route: '/achievements/:achievementId/revisions', resource: 'achievementId' },
];

/** Sends a case as `client`: JSON, or an image upload. */
function send(client: TestClient, test: Case, url: string) {
  return test.upload
    ? client.upload(url, png, 'image/png', 'PUT')
    : client.request(test.method, url, test.body);
}

function url(orgId: string, route: string, ids: Partial<Tenant>) {
  return `/api/v1/orgs/${orgId}${route}`
    .replace(':memberId', ids.memberId ?? '')
    .replace(':invitationId', ids.invitationId ?? '')
    .replace(':issuerId', ids.issuerId ?? '')
    .replace(':achievementId', ids.achievementId ?? '');
}

/** Everything of org B's that an intruder might change. */
async function snapshotB() {
  return {
    org: await env.ownerDb.select().from(organization).where(eq(organization.id, b.orgId)),
    issuers: await env.ownerDb.select().from(issuer).where(eq(issuer.orgId, b.orgId)),
    members: await env.ownerDb.select().from(member).where(eq(member.orgId, b.orgId)),
    invitations: await env.ownerDb.select().from(invitation).where(eq(invitation.orgId, b.orgId)),
    achievements: await env.ownerDb
      .select()
      .from(achievement)
      .where(eq(achievement.orgId, b.orgId)),
    files: await env.ownerDb.select().from(file).where(eq(file.orgId, b.orgId)),
  };
}

describe('cross-tenant access', () => {
  it('has a case for every org-scoped endpoint', () => {
    const prefix = '/api/v1/orgs/:orgId';
    const registered = new Set(
      env.routes
        .filter((route) => route.url.startsWith(prefix) && route.method !== 'HEAD')
        .map((route) => `${route.method} ${route.url.slice(prefix.length).replace(/\/$/, '')}`),
    );
    const covered = new Set(CASES.map((test) => `${test.method} ${test.route}`));
    expect([...registered].sort()).toEqual([...covered].sort());
  });

  it("can't reach another org through its id", async () => {
    const before = await snapshotB();
    for (const test of CASES) {
      const response = await send(a.owner, test, url(b.orgId, test.route, b));
      expect(response.statusCode, `${test.method} ${test.route}`).toBe(404);
      expect(response.json(), `${test.method} ${test.route}`).toMatchObject({ code: 'not_found' });
    }
    expect(await snapshotB()).toEqual(before);
  });

  it("can't reach another org's resources through its own org", async () => {
    const before = await snapshotB();
    for (const test of CASES.filter((item) => item.resource)) {
      const response = await send(a.owner, test, url(a.orgId, test.route, b));
      expect(response.statusCode, `${test.method} ${test.route}`).toBe(404);
    }
    expect(await snapshotB()).toEqual(before);
  });

  it("never lists another org's data", async () => {
    const bIds = [b.orgId, b.issuerId, b.memberId, b.invitationId, b.achievementId];
    for (const test of CASES.filter((item) => item.method === 'GET' && !item.resource)) {
      const response = await a.owner.get(url(a.orgId, test.route, a));
      expect(response.statusCode, test.route).toBe(200);
      for (const id of bIds) expect(response.body, `${test.route} leaks ${id}`).not.toContain(id);
    }
  });

  it("can't accept another org's invitation by id", async () => {
    const response = await a.owner.post(`/api/v1/me/invitations/${b.invitationId}/accept`);
    expect(response.statusCode).toBe(404);
    const [row] = await env.ownerDb
      .select()
      .from(invitation)
      .where(eq(invitation.id, b.invitationId));
    expect(row?.status).toBe('pending');
  });

  it("keeps another org's audit log separate", async () => {
    const events = await env.ownerDb.select().from(auditEvent).where(eq(auditEvent.orgId, b.orgId));
    const aOwnerId = ((await a.owner.me()) as { user: { id: string } }).user.id;
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.actorId === aOwnerId)).toBe(false);
  });

  it('keeps platform endpoints for platform admins', async () => {
    for (const path of ['/orgs', `/orgs/${b.orgId}/approve`, `/orgs/${b.orgId}/suspend`]) {
      const method = path === '/orgs' ? 'GET' : 'POST';
      const response = await a.owner.request(
        method,
        `/api/v1/platform${path}`,
        method === 'POST' ? {} : undefined,
      );
      expect(response.statusCode, path).toBe(403);
    }
  });

  it('treats a malformed org id as not found', async () => {
    const response = await a.owner.get('/api/v1/orgs/not-a-uuid/issuers');
    expect(response.statusCode).toBe(404);
  });
});
