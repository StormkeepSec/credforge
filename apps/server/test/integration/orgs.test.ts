import { auditEvent, eq, organization, user } from '@credforge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expectProblem,
  lastEmailTo,
  linkIn,
  newUser,
  TestClient,
  verificationLink,
} from './support/client';
import { createTestEnvironment, type TestEnvironment } from './support/harness';

function invitationToken(env: TestEnvironment, email: string) {
  return (
    linkIn(lastEmailTo(env, email, 'invitation').text, /\/invite\/[\w-]+/)
      .split('/')
      .pop() ?? ''
  );
}

async function members(client: TestClient, orgId: string) {
  return (
    (await client.get(`/api/v1/orgs/${orgId}/members`)).json() as {
      members: { id: string; email: string; role: string }[];
    }
  ).members;
}

async function actions(env: TestEnvironment, orgId: string) {
  const rows = await env.ownerDb.select().from(auditEvent).where(eq(auditEvent.orgId, orgId));
  return rows.map((row) => row.action);
}

describe('approval instance (SIGNUP_MODE=approval)', () => {
  let env: TestEnvironment;
  let admin: TestClient;
  beforeAll(async () => {
    env = await createTestEnvironment({ SIGNUP_MODE: 'approval' });
    admin = await newUser(env, { platformAdmin: true, email: 'operator@example.org' });
  });
  afterAll(async () => {
    await env?.close();
  });

  async function pendingOrg(name = 'Example Academy') {
    const owner = await newUser(env);
    const created = await owner.post('/api/v1/orgs', { name });
    expect(created.statusCode).toBe(201);
    return {
      owner,
      org: created.json() as { id: string; status: string; role: string; permissions: string[] },
    };
  }

  it('creates orgs as pending, with the creator as owner', async () => {
    const { owner, org } = await pendingOrg();
    expect(org).toMatchObject({ status: 'pending', role: 'owner' });
    expect(org.permissions).toContain('member:manage');
    expect((await owner.me()).memberships).toEqual([
      expect.objectContaining({
        role: 'owner',
        org: expect.objectContaining({ id: org.id, status: 'pending' }),
      }),
    ]);
    expect(await actions(env, org.id)).toEqual(['org.created']);
    expect(lastEmailTo(env, admin.email, 'org-submitted').subject).toContain('Example Academy');
  });

  it('lets a pending org set itself up', async () => {
    const { owner, org } = await pendingOrg('Setting Up');
    expect((await owner.patch(`/api/v1/orgs/${org.id}`, { name: 'Set Up' })).statusCode).toBe(200);
    expect(
      (await owner.post(`/api/v1/orgs/${org.id}/issuers`, { name: 'Set Up' })).statusCode,
    ).toBe(201);
    expect(
      (
        await owner.post(`/api/v1/orgs/${org.id}/invitations`, {
          email: 'colleague@example.org',
          role: 'issuer',
        })
      ).statusCode,
    ).toBe(201);
  });

  it('limits how many orgs one person can have waiting', async () => {
    const owner = await newUser(env);
    for (const name of ['One', 'Two', 'Three']) {
      expect((await owner.post('/api/v1/orgs', { name })).statusCode).toBe(201);
    }
    expectProblem(await owner.post('/api/v1/orgs', { name: 'Four' }), 409, 'conflict');
  });

  it('shows platform admins the queue and lets them approve', async () => {
    const { owner, org } = await pendingOrg('Queue Academy');
    await owner.post(`/api/v1/orgs/${org.id}/issuers`, {
      name: 'Queue Academy',
      url: 'https://queue.example.org',
    });

    const queue = (await admin.get('/api/v1/platform/orgs?status=pending')).json() as {
      orgs: {
        id: string;
        requestedBy: { email: string };
        issuers: { website: string }[];
        memberCount: number;
      }[];
    };
    const entry = queue.orgs.find((row) => row.id === org.id);
    expect(entry).toMatchObject({
      requestedBy: { email: owner.email },
      memberCount: 1,
      issuers: [expect.objectContaining({ website: 'https://queue.example.org' })],
    });

    const approved = await admin.post(`/api/v1/platform/orgs/${org.id}/approve`);
    expect(approved.json()).toMatchObject({ status: 'active' });
    expect(lastEmailTo(env, owner.email, 'org-approved').subject).toContain('approved');
    const [row] = await env.ownerDb.select().from(organization).where(eq(organization.id, org.id));
    expect(row?.approvedAt).toBeInstanceOf(Date);
    expect(await actions(env, org.id)).toContain('org.approved');

    expectProblem(await admin.post(`/api/v1/platform/orgs/${org.id}/approve`), 409, 'conflict');
  });

  it('declines with a reason, and a declined org is read-only', async () => {
    const { owner, org } = await pendingOrg('Fake University');
    const declined = await admin.post(`/api/v1/platform/orgs/${org.id}/decline`, {
      reason: 'Could not confirm the organization.',
    });
    expect(declined.json()).toMatchObject({
      status: 'declined',
      statusReason: 'Could not confirm the organization.',
    });
    expect(lastEmailTo(env, owner.email, 'org-declined').text).toContain(
      'Could not confirm the organization.',
    );
    expectProblem(
      await owner.patch(`/api/v1/orgs/${org.id}`, { name: 'Renamed' }),
      403,
      'org_inactive',
    );
    expect((await owner.get(`/api/v1/orgs/${org.id}`)).json()).toMatchObject({
      status: 'declined',
    });
  });

  it('suspends and reinstates', async () => {
    const { owner, org } = await pendingOrg('Suspended Co');
    await admin.post(`/api/v1/platform/orgs/${org.id}/approve`);
    await admin.post(`/api/v1/platform/orgs/${org.id}/suspend`, { reason: 'Abuse report' });
    expectProblem(
      await owner.post(`/api/v1/orgs/${org.id}/issuers`, { name: 'Nope' }),
      403,
      'org_inactive',
    );
    expect(lastEmailTo(env, owner.email, 'org-suspended').text).toContain('Abuse report');
    const reinstated = await admin.post(`/api/v1/platform/orgs/${org.id}/reinstate`);
    expect(reinstated.json()).toMatchObject({ status: 'active', statusReason: null });
    expect((await owner.post(`/api/v1/orgs/${org.id}/issuers`, { name: 'Back' })).statusCode).toBe(
      201,
    );
  });

  it('activates a platform admin’s own org at once', async () => {
    const created = await admin.post('/api/v1/orgs', { name: 'Operator Org' });
    expect(created.json()).toMatchObject({ status: 'active' });
  });

  it('keeps the queue from everyone else', async () => {
    const { owner } = await pendingOrg('Curious');
    expectProblem(await owner.get('/api/v1/platform/orgs'), 403, 'forbidden');
  });
});

describe('members and invitations', () => {
  let env: TestEnvironment;
  let owner: TestClient;
  let orgId: string;
  beforeAll(async () => {
    env = await createTestEnvironment({ SIGNUP_MODE: 'open' });
    owner = await newUser(env);
    orgId = ((await owner.post('/api/v1/orgs', { name: 'Team' })).json() as { id: string }).id;
  });
  afterAll(async () => {
    await env?.close();
  });

  async function join(role: string, options: { twoFactor?: boolean } = {}) {
    // Owners and admins need two-step verification (REQUIRE_MFA_FOR_ADMINS defaults to true).
    const privileged = role === 'owner' || role === 'admin';
    const person = await newUser(env, { twoFactor: options.twoFactor ?? privileged });
    expect(
      (await owner.post(`/api/v1/orgs/${orgId}/invitations`, { email: person.email, role }))
        .statusCode,
    ).toBe(201);
    const accepted = await person.post(
      `/api/v1/invitations/${invitationToken(env, person.email)}/accept`,
    );
    expect(accepted.statusCode).toBe(200);
    const memberId =
      (await members(owner, orgId)).find((row) => row.email === person.email)?.id ?? '';
    return { person, memberId };
  }

  it('invites by email; the invited address accepts with any sign-in', async () => {
    const invited = await owner.post(`/api/v1/orgs/${orgId}/invitations`, {
      email: 'New.Person@Example.org',
      role: 'issuer',
    });
    expect(invited.json()).toMatchObject({ email: 'new.person@example.org', role: 'issuer' });
    const message = lastEmailTo(env, 'new.person@example.org', 'invitation');
    expect(message.subject).toBe('Join Team on credforge');
    const token = invitationToken(env, 'new.person@example.org');

    // The invitation page works before sign-in.
    const preview = await new TestClient(env, '', '').get(`/api/v1/invitations/${token}`);
    expect(preview.json()).toMatchObject({
      email: 'new.person@example.org',
      role: 'issuer',
      org: { id: orgId, name: 'Team' },
    });

    // Someone else can't use the link.
    const other = await newUser(env, { twoFactor: false });
    expectProblem(
      await other.post(`/api/v1/invitations/${token}/accept`),
      403,
      'invitation_email_mismatch',
    );

    const person = await newUser(env, { email: 'new.person@example.org', twoFactor: false });
    expect((await person.me()).invitations).toEqual([
      expect.objectContaining({ org: { id: orgId, name: 'Team' }, role: 'issuer' }),
    ]);
    expect((await person.post(`/api/v1/invitations/${token}/accept`)).json()).toMatchObject({
      role: 'issuer',
    });
    expect((await person.get(`/api/v1/orgs/${orgId}`)).json()).toMatchObject({ role: 'issuer' });
    // Used once.
    expectProblem(
      await person.post(`/api/v1/invitations/${token}/accept`),
      404,
      'invitation_invalid',
    );
  });

  it('accepts from the list of my invitations', async () => {
    const person = await newUser(env, { twoFactor: false });
    const invited = (
      await owner.post(`/api/v1/orgs/${orgId}/invitations`, { email: person.email, role: 'viewer' })
    ).json() as { id: string };
    expect((await person.post(`/api/v1/me/invitations/${invited.id}/accept`)).statusCode).toBe(200);
  });

  it('refuses to invite an existing member', async () => {
    const { person } = await join('viewer');
    expectProblem(
      await owner.post(`/api/v1/orgs/${orgId}/invitations`, { email: person.email, role: 'admin' }),
      409,
      'already_member',
    );
  });

  it('sends a fresh link on resend, and the old one stops working', async () => {
    const email = 'resend@example.org';
    const invited = (
      await owner.post(`/api/v1/orgs/${orgId}/invitations`, { email, role: 'viewer' })
    ).json() as { id: string };
    const first = invitationToken(env, email);
    await owner.post(`/api/v1/orgs/${orgId}/invitations/${invited.id}/resend`);
    const second = invitationToken(env, email);
    expect(second).not.toBe(first);
    expect((await new TestClient(env, '', '').get(`/api/v1/invitations/${first}`)).statusCode).toBe(
      404,
    );
    expect(
      (await new TestClient(env, '', '').get(`/api/v1/invitations/${second}`)).statusCode,
    ).toBe(200);
  });

  it('revokes an invitation', async () => {
    const email = 'revoked@example.org';
    const invited = (
      await owner.post(`/api/v1/orgs/${orgId}/invitations`, { email, role: 'viewer' })
    ).json() as { id: string };
    expect((await owner.delete(`/api/v1/orgs/${orgId}/invitations/${invited.id}`)).statusCode).toBe(
      204,
    );
    expect(
      (await new TestClient(env, '', '').get(`/api/v1/invitations/${invitationToken(env, email)}`))
        .statusCode,
    ).toBe(404);
    const open = (await owner.get(`/api/v1/orgs/${orgId}/invitations`)).json() as {
      invitations: { email: string }[];
    };
    expect(open.invitations.map((row) => row.email)).not.toContain(email);
  });

  it('checks permissions, not role names', async () => {
    const { person: viewer } = await join('viewer');
    expectProblem(
      await viewer.post(`/api/v1/orgs/${orgId}/invitations`, {
        email: 'x@example.org',
        role: 'viewer',
      }),
      403,
      'forbidden',
    );
    expectProblem(
      await viewer.patch(`/api/v1/orgs/${orgId}`, { name: 'Mine now' }),
      403,
      'forbidden',
    );
    expectProblem(await viewer.get(`/api/v1/orgs/${orgId}/audit-events`), 403, 'forbidden');
    expect((await viewer.get(`/api/v1/orgs/${orgId}/members`)).statusCode).toBe(200);

    const { person: issuer } = await join('issuer');
    expectProblem(
      await issuer.post(`/api/v1/orgs/${orgId}/issuers`, { name: 'x' }),
      403,
      'forbidden',
    );
  });

  it('stops admins from creating or changing owners', async () => {
    const { person: admin } = await join('admin');
    expectProblem(
      await admin.post(`/api/v1/orgs/${orgId}/invitations`, {
        email: 'boss@example.org',
        role: 'owner',
      }),
      403,
      'forbidden',
    );
    const ownerMember = (await members(owner, orgId)).find((row) => row.email === owner.email);
    expectProblem(
      await admin.patch(`/api/v1/orgs/${orgId}/members/${ownerMember?.id}`, { role: 'viewer' }),
      403,
      'forbidden',
    );
    expectProblem(
      await admin.delete(`/api/v1/orgs/${orgId}/members/${ownerMember?.id}`),
      403,
      'forbidden',
    );

    const { memberId } = await join('viewer');
    expect(
      (await admin.patch(`/api/v1/orgs/${orgId}/members/${memberId}`, { role: 'issuer' })).json(),
    ).toMatchObject({ role: 'issuer' });
    expectProblem(
      await admin.patch(`/api/v1/orgs/${orgId}/members/${memberId}`, { role: 'owner' }),
      403,
      'forbidden',
    );
  });

  it('always keeps an owner', async () => {
    const self = (await members(owner, orgId)).find((row) => row.email === owner.email);
    expectProblem(
      await owner.patch(`/api/v1/orgs/${orgId}/members/${self?.id}`, { role: 'admin' }),
      409,
      'last_owner',
    );
    expectProblem(
      await owner.delete(`/api/v1/orgs/${orgId}/members/${self?.id}`),
      409,
      'last_owner',
    );

    const { memberId: secondOwner } = await join('owner');
    expect(
      (await owner.patch(`/api/v1/orgs/${orgId}/members/${self?.id}`, { role: 'admin' }))
        .statusCode,
    ).toBe(200);
    expectProblem(
      await owner.patch(`/api/v1/orgs/${orgId}/members/${secondOwner}`, { role: 'admin' }),
      403,
      'forbidden',
    );
  });

  it('lets anyone leave', async () => {
    const { person, memberId } = await join('viewer');
    expect((await person.delete(`/api/v1/orgs/${orgId}/members/${memberId}`)).statusCode).toBe(204);
    expectProblem(await person.get(`/api/v1/orgs/${orgId}`), 404, 'not_found');
    expect(await actions(env, orgId)).toContain('member.left');
  });

  it('records every change in the audit log', async () => {
    const page = (await owner.get(`/api/v1/orgs/${orgId}/audit-events?limit=200`)).json() as {
      events: { action: string; actor: { label: string } }[];
    };
    const seen = new Set(page.events.map((event) => event.action));
    for (const action of [
      'org.created',
      'invitation.created',
      'invitation.resent',
      'invitation.revoked',
      'member.joined',
      'member.role_changed',
      'member.left',
    ]) {
      expect(seen, action).toContain(action);
    }
  });
});

describe('invite-only instance (SIGNUP_MODE=invite)', () => {
  let env: TestEnvironment;
  beforeAll(async () => {
    env = await createTestEnvironment({ SIGNUP_MODE: 'invite' });
  });
  afterAll(async () => {
    await env?.close();
  });

  it('accepts new accounts only for invited addresses, and only admins create orgs', async () => {
    const stranger = new TestClient(env, 'stranger@example.org', 'correct horse battery');
    // Better Auth answers like a normal sign-up (no account enumeration), but creates nothing.
    const refused = await stranger.post('/api/auth/sign-up/email', {
      name: 'Stranger',
      email: stranger.email,
      password: stranger.password,
    });
    expect(refused.statusCode).toBe(200);
    expect(await env.ownerDb.select().from(user).where(eq(user.email, stranger.email))).toEqual([]);
    expect(env.outbox.messages.filter((sent) => sent.to === stranger.email)).toEqual([]);

    // A platform admin (made with the CLI in real life) creates the org and invites someone.
    const [created] = await env.ownerDb
      .insert(organization)
      .values({ name: 'Invite Only', status: 'active' })
      .returning();
    const admin = new TestClient(env, 'admin@example.org', 'correct horse battery');
    // The admin's own invitation lets them sign up.
    await env.ownerDb.execute(
      `insert into invitation (org_id, email, role, token_hash, expires_at) values ('${created?.id}', 'admin@example.org', 'owner', 'x', now() + interval '1 day')`,
    );
    const signUp = await admin.post('/api/auth/sign-up/email', {
      name: 'Admin',
      email: admin.email,
      password: admin.password,
    });
    expect(signUp.statusCode).toBe(200);
    const link = new URL(verificationLink(env, admin.email));
    await admin.get(link.pathname + link.search);
    expectProblem(await admin.post('/api/v1/orgs', { name: 'Mine' }), 403, 'signup_closed');
  });
});
