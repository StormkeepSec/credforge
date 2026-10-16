import type { AuditEventPage, BulkRevokeResult, CredentialDetails } from '@credforge/contracts';
import { auditEvent, credential, emailMessage, eq, statusList } from '@credforge/db';
import { Bitstring, verifyCredential } from '@credforge/ob3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeliveryTracker } from '../../src/email/tracking';
import { createJobQueue, STATUS_LIST_DEBOUNCE_SECONDS } from '../../src/jobs/enqueue';
import { QUEUES } from '../../src/jobs/queues';
import { createLocalResolvers } from '../../src/verify/local';
import { expectProblem, lastEmailTo, newUser } from './support/client';
import { BASE_URL, createTestEnvironment, type TestEnvironment } from './support/harness';
import { awardTo, type IssuingOrg, issuingOrg, publishStatusLists } from './support/issuing';

let env: TestEnvironment;
let org: IssuingOrg;

const path = (url: string) => url.replace(BASE_URL, '');
const page = (url: string) =>
  env.app.inject({ method: 'GET', url: path(url), headers: { accept: 'text/html' } });

async function verify(id: string) {
  const [row] = await env.ownerDb.select().from(credential).where(eq(credential.id, id));
  return verifyCredential(row?.document, createLocalResolvers(env.db, BASE_URL));
}

async function bitOf(id: string): Promise<boolean> {
  const [row] = await env.ownerDb.select().from(credential).where(eq(credential.id, id));
  const [list] = await env.ownerDb
    .select()
    .from(statusList)
    .where(eq(statusList.id, row?.statusListId ?? ''));
  if (!row || !list) throw new Error('no credential or status list');
  const { credentialSubject } = list.document as { credentialSubject: { encodedList: string } };
  return Bitstring.decode(credentialSubject.encodedList).get(row.statusListIndex ?? -1);
}

beforeAll(async () => {
  env = await createTestEnvironment({ SIGNUP_MODE: 'open' });
  org = await issuingOrg(env);
});
afterAll(async () => {
  await env?.close();
});

describe('revoking', () => {
  let id: string;

  it('needs an internal reason', async () => {
    id = await awardTo(org, { name: 'Ada Lovelace', email: 'ada@example.org' });
    expectProblem(
      await org.owner.post(`${org.api}/credentials/${id}/revoke`, {}),
      400,
      'validation_failed',
    );
  });

  it('flips the bit now and publishes the signed list when the worker runs', async () => {
    const [before] = await env.ownerDb.select().from(statusList);
    const response = await org.owner.post(`${org.api}/credentials/${id}/revoke`, {
      reason: 'Awarded by mistake (ticket 42)',
      publicReason: 'Issued in error',
    });
    expect(response.statusCode, response.body).toBe(200);
    const revoked = response.json() as CredentialDetails;
    expect(revoked).toMatchObject({
      status: 'revoked',
      state: 'revoked',
      revocation: {
        kind: 'revoked',
        reason: 'Awarded by mistake (ticket 42)',
        publicReason: 'Issued in error',
      },
      revokedBy: { label: org.owner.email },
    });

    const [waiting] = await env.ownerDb.select().from(statusList);
    expect(waiting?.needsPublish).toBe(true);
    expect(waiting?.version).toBe(before?.version);
    expect(await bitOf(id)).toBe(false);

    // Until the list is re-signed, the page says what the issuer did.
    const early = await page(revoked.url);
    expect(early.body).toContain('Revoked on');
    expect(early.body).toContain(
      'The issuer has revoked this credential. Its signed status list is being updated',
    );

    expect(await publishStatusLists(env)).toBe(1);
    const [published] = await env.ownerDb.select().from(statusList);
    expect(published).toMatchObject({ needsPublish: false, version: (before?.version ?? 0) + 1 });
    expect(await bitOf(id)).toBe(true);
    const result = await verify(id);
    expect(result.checks.status).toMatchObject({
      outcome: 'failed',
      message: 'The issuer has revoked this credential',
    });
    expect(result.checks.proof.outcome).toBe('passed');
    expect(await publishStatusLists(env)).toBe(0);

    const list = await env.app.inject({
      method: 'GET',
      url: path(
        (revoked.document as { credentialStatus: { statusListCredential: string } })
          .credentialStatus.statusListCredential,
      ),
    });
    expect(list.headers.etag).toBe(`"${published?.id.slice(0, 8)}-${published?.version}"`);
  });

  it('shows the date and the public reason on the page, never the internal one', async () => {
    const response = await page(`${BASE_URL}/credentials/${id}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Revoked on');
    expect(response.body).toContain('Example Cyber Academy revoked this badge.');
    expect(response.body).toContain('Reason given by the issuer: Issued in error');
    expect(response.body).not.toContain('ticket 42');
    expect(response.body).toContain('The issuer has revoked this credential');
  });

  it('refuses to revoke twice, and records who revoked and why', async () => {
    expectProblem(
      await org.owner.post(`${org.api}/credentials/${id}/revoke`, { reason: 'again' }),
      409,
      'already_revoked',
    );
    expectProblem(await org.owner.post(`${org.api}/credentials/${id}/resend`), 409, 'conflict');
    // Stored sealed: the org's reasons may name the recipient (design plan §12.1).
    const events = await env.ownerDb.select().from(auditEvent).where(eq(auditEvent.targetId, id));
    const stored = events.find((row) => row.action === 'credential.revoked');
    expect(stored).toMatchObject({
      actorLabel: org.owner.email,
      data: { kind: 'revoked', sealed: expect.any(String) },
    });
    expect(JSON.stringify(stored?.data)).not.toContain('ticket 42');
    // …and read back whole.
    const log = (await org.owner.get(`${org.api}/audit-events`)).json() as AuditEventPage;
    const event = log.events.find(
      (row) => row.action === 'credential.revoked' && row.target?.id === id,
    );
    expect(event).toMatchObject({
      actor: { label: org.owner.email },
      data: {
        kind: 'revoked',
        reason: 'Awarded by mistake (ticket 42)',
        publicReason: 'Issued in error',
        recipientName: 'Ada Lovelace',
        recipientEmail: 'ada@example.org',
      },
    });
  });

  it('revokes many at once and reports the rest', async () => {
    const ids = [
      await awardTo(org, { name: 'Bulk One', email: 'bulk1@example.org' }),
      await awardTo(org, { name: 'Bulk Two', email: 'bulk2@example.org' }),
    ];
    const missing = crypto.randomUUID();
    const response = await org.owner.post(`${org.api}/credentials/revoke`, {
      credentialIds: [...ids, id, missing],
      reason: 'Course cancelled',
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json() as BulkRevokeResult;
    expect(result.revoked.sort()).toEqual([...ids].sort());
    expect(result.alreadyRevoked).toEqual([id]);
    expect(result.notFound).toEqual([missing]);
    expect(await publishStatusLists(env)).toBe(1);
    for (const each of ids) expect(await bitOf(each)).toBe(true);
  });

  it('doesn’t send a queued award email for a badge revoked before it went out', async () => {
    const queued = await awardTo(org, { name: 'Quick Revoke', email: 'quick@example.org' });
    await org.owner.post(`${org.api}/credentials/${queued}/revoke`, { reason: 'Wrong person' });
    const [message] = await env.ownerDb
      .select()
      .from(emailMessage)
      .where(eq(emailMessage.credentialId, queued));
    const check = await createDeliveryTracker(env.db).beforeSend(message?.id ?? '');
    expect(check).toEqual({
      send: false,
      reason: 'Not sent: the badge was revoked before the email went out.',
    });
  });

  it('lets only people with the revoke permission revoke', async () => {
    const viewer = await newUser(env, { twoFactor: false });
    await org.owner.post(`${org.api}/invitations`, { email: viewer.email, role: 'viewer' });
    const token = lastEmailTo(env, viewer.email, 'invitation').text.match(/\/invite\/(\S+)/)?.[1];
    await viewer.post(`/api/v1/invitations/${token}/accept`);
    const target = await awardTo(org, { name: 'Safe', email: 'safe@example.org' });
    expectProblem(
      await viewer.post(`${org.api}/credentials/${target}/revoke`, { reason: 'x' }),
      403,
      'forbidden',
    );
    expectProblem(
      await viewer.post(`${org.api}/credentials/revoke`, { credentialIds: [target], reason: 'x' }),
      403,
      'forbidden',
    );
  });
});

describe('reissuing', () => {
  it('signs a corrected copy, supersedes the old one, links them and emails the recipient', async () => {
    const oldId = await awardTo(
      org,
      { name: 'Grace Hoper', email: 'grace@example.org' },
      { issuedOn: '2026-03-01', evidence: [{ url: 'https://example.org/grace' }] },
    );
    const response = await org.owner.post(`${org.api}/credentials/${oldId}/reissue`, {
      recipient: { name: 'Grace Hopper', email: 'grace.hopper@example.org' },
      reason: 'Name misspelled; new address',
    });
    expect(response.statusCode, response.body).toBe(201);
    const fresh = response.json() as CredentialDetails;
    expect(fresh).toMatchObject({
      status: 'issued',
      recipient: { name: 'Grace Hopper', email: 'grace.hopper@example.org' },
      replacesId: oldId,
      validFrom: '2026-03-01T00:00:00.000Z',
      evidence: [{ url: 'https://example.org/grace', name: null, narrative: null }],
    });
    expect((await verify(fresh.id)).verified).toBe(true);

    const old = (
      await org.owner.get(`${org.api}/credentials/${oldId}`)
    ).json() as CredentialDetails;
    expect(old).toMatchObject({
      status: 'revoked',
      replacedById: fresh.id,
      revocation: {
        kind: 'superseded',
        reason: 'Name misspelled; new address',
        publicReason: null,
      },
    });

    const email = lastEmailTo(env, 'grace.hopper@example.org', 'award');
    expect(email.subject).toBe(
      'Example Cyber Academy corrected your Intro to Network Defense badge',
    );
    expect(email.text).toContain('sent you a corrected copy');
    expect(email.text).toContain(`${BASE_URL}/credentials/${fresh.id}?t=`);

    await publishStatusLists(env);
    expect(await bitOf(oldId)).toBe(true);
    const oldPage = await page(old.url);
    expect(oldPage.body).toContain('replaced this badge with a corrected copy');
    expect(oldPage.body).not.toContain(fresh.id);

    const actions = (
      await env.ownerDb.select().from(auditEvent).where(eq(auditEvent.targetId, oldId))
    ).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(['credential.revoked', 'credential.reissued']));

    expectProblem(
      await org.owner.post(`${org.api}/credentials/${oldId}/reissue`, {}),
      409,
      'already_revoked',
    );
  });

  it('copies everything that isn’t corrected', async () => {
    const oldId = await awardTo(
      org,
      { name: 'Alan Turing', email: 'alan@example.org' },
      { expiresOn: '2030-01-01', sendEmail: false },
    );
    const response = await org.owner.post(`${org.api}/credentials/${oldId}/reissue`, {
      sendEmail: false,
    });
    const fresh = response.json() as CredentialDetails;
    expect(fresh).toMatchObject({
      recipient: { name: 'Alan Turing', email: 'alan@example.org' },
      validUntil: '2030-01-01T23:59:59.000Z',
      delivery: 'not_sent',
    });
  });
});

describe('the job queue', () => {
  it('debounces status lists and keys batches, inside the caller’s transaction', async () => {
    const sent: { name: string; data: unknown; options: Record<string, unknown> }[] = [];
    const jobs = createJobQueue({
      send: async (name: string, data: unknown, options: Record<string, unknown>) => {
        sent.push({ name, data, options });
        return null;
      },
    } as never);
    await env.db.transaction(async (tx) => {
      await jobs.publishStatusList('list-1', { tx });
      await jobs.issueBatch('batch-1');
    });
    expect(sent[0]).toMatchObject({
      name: QUEUES.statusList,
      data: { statusListId: 'list-1' },
      options: {
        singletonKey: 'list-1',
        startAfter: STATUS_LIST_DEBOUNCE_SECONDS,
        db: expect.anything(),
      },
    });
    expect(sent[1]).toMatchObject({
      name: QUEUES.batch,
      data: { batchId: 'batch-1' },
      options: { singletonKey: 'batch-1' },
    });
    expect(sent[1]?.options).not.toHaveProperty('db');
  });
});
