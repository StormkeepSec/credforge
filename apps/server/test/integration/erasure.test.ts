import {
  API_KEY_SCOPES,
  type AuditEventPage,
  type BatchRowPage,
  type CredentialDetails,
  type CredentialPage,
  type RecipientErasurePreview,
  type RecipientErasureResult,
  type VerifyResult,
} from '@credforge/contracts';
import {
  and,
  auditEvent,
  credential,
  emailMessage,
  eq,
  file,
  inArray,
  instanceSettings,
  issuanceBatch,
  issuanceBatchRow,
  member,
  user,
} from '@credforge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealEarlierAuditEvents } from '../../src/audit/seal-earlier-events';
import { issueBatch } from '../../src/batches/service';
import { reapplyErasures } from '../../src/credentials/erasure';
import { TRACKING_ARG } from '../../src/email/sendgrid';
import { applySendGridEvents } from '../../src/email/tracking';
import { expectProblem, lastEmailTo, newUser } from './support/client';
import { BASE_URL, createTestEnvironment, type TestEnvironment } from './support/harness';
import {
  awardTo,
  type IssuingOrg,
  issuingOrg,
  publishedAchievement,
  publishStatusLists,
  workerServices,
} from './support/issuing';

/**
 * Erasing a recipient's data (design plan §12.1, decision 50): one request reaches every badge
 * the org awarded to the address, the badges linked to them by a reissue, emails, queued email
 * jobs, CSV rows and uploads, and what the append-only audit log says about the person, while the
 * badges stay revoked and checkable as revoked.
 */

let env: TestEnvironment;
let org: IssuingOrg;

const QUINN = { name: 'Quinn Erasable', email: 'quinn@example.org' };
const SAM = { name: 'Sam Keeper', email: 'sam@example.org' };
/** Anything that would identify Quinn, in any form the tests put it. */
const TRACES = ['quinn', 'quin@', 'erasable', 'quinnbrowser'];

const path = (url: string) => url.replace(BASE_URL, '');
const anonymous = (url: string, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'GET', url: path(url), headers });

function tracesIn(value: unknown): string[] {
  const text = JSON.stringify(value).toLowerCase();
  return TRACES.filter((trace) => text.includes(trace));
}

async function details(id: string) {
  const response = await org.owner.get(`${org.api}/credentials/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as CredentialDetails;
}

async function uploadCsv(achievementId: string, csv: string, fileName: string) {
  const response = await org.owner.upload(
    `${org.api}/batches?achievementId=${achievementId}&fileName=${fileName}`,
    Buffer.from(csv),
    'text/csv',
    'POST',
  );
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

async function emailJobs(messageIds: string[]) {
  const { rows } = await env.ownerPool.query<{ count: number }>(
    `select count(*)::int as count from pgboss.job where name = 'email.send' and data->>'trackingId' = any($1)`,
    [messageIds],
  );
  return rows[0]?.count ?? 0;
}

beforeAll(async () => {
  env = await createTestEnvironment({ SIGNUP_MODE: 'open' }, { queue: true });
  org = await issuingOrg(env);
});
afterAll(async () => {
  await env?.close();
});

describe('erasing a recipient', () => {
  /** c1 and c4 by hand, c2 revoked, c3 to a mistyped address and reissued as c4, c5 from a CSV. */
  const ids = { c1: '', c2: '', c3: '', c4: '', c5: '', sam: '' };
  let achievementB: string;
  let awardedBatch: string;
  let draftBatch: string;
  let messageIds: string[];
  let signed: Record<string, unknown>;
  let claimToken: string;
  let result: RecipientErasureResult;

  it('sets up everything the org holds about Quinn', async () => {
    ids.c1 = await awardTo(org, QUINN, { evidence: [{ url: 'https://example.org/quinn/lab' }] });
    const link = lastEmailTo(env, QUINN.email, 'award').text.match(/https:\/\/\S+\?t=(\S+)/);
    claimToken = link?.[1] ?? '';
    // Quinn opens the claim link: their name, IP address and browser go into sealed details.
    const claimed = await anonymous(`/credentials/${ids.c1}?t=${claimToken}`, {
      'user-agent': 'QuinnBrowser/1.0',
    });
    expect(claimed.statusCode).toBe(303);

    achievementB = await publishedAchievement(org.owner, org.api, 'Advanced Network Defense');
    ids.c2 = await awardTo(org, QUINN, { achievementId: achievementB });
    await org.owner.post(`${org.api}/credentials/${ids.c2}/revoke`, {
      reason: 'Quinn asked us to take it down',
      publicReason: 'Withdrawn at Quinn’s request',
    });

    ids.c3 = await awardTo(org, { name: QUINN.name, email: 'quin@example.org' });
    const reissued = await org.owner.post(`${org.api}/credentials/${ids.c3}/reissue`, {
      recipient: { email: QUINN.email },
      reason: 'Typo in Quinn’s address',
    });
    expect(reissued.statusCode, reissued.body).toBe(201);
    ids.c4 = (reissued.json() as { id: string }).id;

    awardedBatch = await uploadCsv(
      achievementB,
      `Name,Email,Student ID\n${QUINN.name},${QUINN.email},S-QUINN\n${SAM.name},${SAM.email},S-SAM\n`,
      'cohort.csv',
    );
    await org.owner.patch(`${org.api}/batches/${awardedBatch}`, {
      columns: ['name', 'email', 'custom'],
    });
    const confirmed = await org.owner.post(`${org.api}/batches/${awardedBatch}/confirm`);
    expect(confirmed.statusCode, confirmed.body).toBeLessThan(300);
    expect(await issueBatch(workerServices(env), awardedBatch)).toBe('done');
    const batchCredentials = await env.ownerDb
      .select()
      .from(credential)
      .where(eq(credential.batchId, awardedBatch));
    ids.c5 = batchCredentials.find((row) => row.recipientEmail === QUINN.email)?.id ?? '';
    ids.sam = batchCredentials.find((row) => row.recipientEmail === SAM.email)?.id ?? '';
    expect(batchCredentials.find((row) => row.id === ids.c5)?.customFields).toEqual({
      'Student ID': 'S-QUINN',
    });

    // A draft that would award Quinn again, with the address in another column's place.
    draftBatch = await uploadCsv(
      org.achievementId,
      `Email,Full name\n QUINN@example.org ,${QUINN.name}\nrobin@example.org,Robin Draft\n`,
      'second-cohort.csv',
    );

    // The provider bounces c1's email, quoting the address.
    const messages = await env.ownerDb
      .select()
      .from(emailMessage)
      .where(inArray(emailMessage.credentialId, [ids.c1, ids.c2, ids.c3, ids.c4, ids.c5, ids.sam]));
    messageIds = messages.filter((row) => row.credentialId !== ids.sam).map((row) => row.id);
    const c1Message = messages.find((row) => row.credentialId === ids.c1)?.id ?? '';
    expect(
      await applySendGridEvents(env.db, [
        {
          event: 'bounce',
          type: 'bounce',
          reason: `550 5.1.1 <${QUINN.email}>: Recipient address rejected`,
          timestamp: Math.floor(Date.now() / 1000),
          sg_event_id: 'bounce-1',
          [TRACKING_ARG]: c1Message,
        },
      ]),
    ).toBe(1);
    // An export searching for Quinn.
    expect((await org.owner.get(`${org.api}/exports/credentials.csv?q=quinn`)).statusCode).toBe(
      200,
    );

    signed = (await details(ids.c1)).document ?? {};
    expect(await emailJobs(messageIds)).toBeGreaterThan(0);
  });

  it('keeps recipient details out of the audit log’s plain columns, and reads them back', async () => {
    const stored = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.orgId, org.orgId));
    expect(tracesIn(stored)).toEqual([]);
    const claimed = stored.find(
      (row) => row.action === 'credential.claimed' && row.targetId === ids.c1,
    );
    expect(claimed).toMatchObject({ actorType: 'recipient', actorLabel: null, ip: null });
    const exported = stored.find((row) => row.action === 'credentials.exported');
    expect(exported?.data).toEqual({ format: 'csv', filters: { search: true } });

    const log = (await org.owner.get(`${org.api}/audit-events?limit=100`)).json() as AuditEventPage;
    const opened = log.events.find(
      (event) => event.action === 'credential.claimed' && event.target?.id === ids.c1,
    );
    expect(opened).toMatchObject({ actor: { type: 'recipient', label: QUINN.name } });
    const issued = log.events.find(
      (event) => event.action === 'credential.issued' && event.target?.id === ids.c1,
    );
    expect(issued?.data).toMatchObject({ recipientName: QUINN.name, recipientEmail: QUINN.email });
    const bounced = log.events.find((event) => event.action === 'email.bounced');
    expect(String(bounced?.data.reason)).toContain(QUINN.email);
  });

  it('shows what erasing would cover, to owners and admins only', async () => {
    const response = await org.owner.get(`${org.api}/credentials/${ids.c1}/erasure`);
    expect(response.statusCode, response.body).toBe(200);
    const preview = response.json() as RecipientErasurePreview;
    expect(preview.recipient).toEqual(QUINN);
    expect(preview.credentials.map((row) => row.id).sort()).toEqual(
      [ids.c1, ids.c2, ids.c3, ids.c4, ids.c5].sort(),
    );
    expect(preview.toRevoke).toBe(3);
    expect(preview.batchRows).toBe(2);

    const issuer = await newUser(env, { twoFactor: false });
    const [row] = await env.ownerDb
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, issuer.email));
    await env.ownerDb
      .insert(member)
      .values({ orgId: org.orgId, userId: row?.id ?? '', role: 'issuer' });
    expectProblem(await issuer.get(`${org.api}/credentials/${ids.c1}/erasure`), 403, 'forbidden');
    expectProblem(await issuer.post(`${org.api}/credentials/${ids.c1}/erasure`), 403, 'forbidden');

    const created = await org.owner.post(`${org.api}/api-keys`, {
      name: 'Everything a key can do',
      scopes: [...API_KEY_SCOPES],
    });
    const { key } = created.json() as { key: string };
    const withKey = await env.app.inject({
      method: 'POST',
      url: `${org.api}/credentials/${ids.c1}/erasure`,
      headers: { authorization: `Bearer ${key}` },
    });
    expectProblem(withKey, 403, 'api_key_not_allowed');
  });

  it('erases them: badges revoked for good, tombstones, emails, jobs, CSV rows and files', async () => {
    const uploads = await env.ownerDb
      .select({ fileId: issuanceBatch.fileId })
      .from(issuanceBatch)
      .where(inArray(issuanceBatch.id, [awardedBatch, draftBatch]));
    const fileIds = uploads.map((row) => row.fileId ?? '');
    const fileKeys = (
      await env.ownerDb.select({ key: file.key }).from(file).where(inArray(file.id, fileIds))
    ).map((row) => row.key);
    expect(fileKeys).toHaveLength(2);

    const response = await org.owner.post(`${org.api}/credentials/${ids.c1}/erasure`);
    expect(response.statusCode, response.body).toBe(200);
    result = response.json() as RecipientErasureResult;
    expect(result.erased.sort()).toEqual([ids.c1, ids.c2, ids.c3, ids.c4, ids.c5].sort());
    expect(result.revoked.sort()).toEqual([ids.c1, ids.c4, ids.c5].sort());
    expect(result.batchRows).toBe(2);

    const rows = await env.ownerDb
      .select()
      .from(credential)
      .where(inArray(credential.id, result.erased));
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'revoked',
        document: null,
        recipientName: null,
        recipientEmail: null,
        emailSalt: null,
        auditKey: null,
        claimTokenHash: null,
        acceptedAt: null,
        revocationReason: null,
        revocationPublicReason: null,
        evidence: [],
        customFields: {},
      });
      expect(row.erasedAt).toBeInstanceOf(Date);
      expect(row.statusListIndex).not.toBeNull();
    }
    const [sam] = await env.ownerDb.select().from(credential).where(eq(credential.id, ids.sam));
    expect(sam).toMatchObject({ status: 'issued', recipientEmail: SAM.email, erasedAt: null });

    // Every bit is set once the worker re-signs the lists, and stays set.
    await publishStatusLists(env);
    const verified = await env.app.inject({
      method: 'POST',
      url: '/api/v1/verify',
      payload: { credential: signed },
    });
    const check = verified.json() as VerifyResult;
    expect(check.checks.proof.outcome).toBe('passed');
    expect(check.checks.status.outcome).toBe('failed');
    expect(check.verified).toBe(false);

    const emails = await env.ownerDb
      .select()
      .from(emailMessage)
      .where(inArray(emailMessage.credentialId, result.erased));
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) {
      expect(email).toMatchObject({ toEmail: null, lastError: null, providerMessageId: null });
    }
    expect(tracesIn(emails)).toEqual([]);
    expect(await emailJobs(messageIds)).toBe(0);

    const batchRows = await env.ownerDb
      .select()
      .from(issuanceBatchRow)
      .where(inArray(issuanceBatchRow.batchId, [awardedBatch, draftBatch]));
    expect(tracesIn(batchRows)).toEqual([]);
    const erasedRows = batchRows.filter((row) => row.erasedAt);
    expect(erasedRows.map((row) => [row.batchId, row.rowNumber, row.status]).sort()).toEqual(
      [
        [awardedBatch, 2, 'issued'],
        [draftBatch, 2, 'skipped'],
      ].sort(),
    );
    for (const row of erasedRows) expect(row).toMatchObject({ cells: [], values: null });
    expect(
      batchRows.find((row) => row.batchId === draftBatch && row.rowNumber === 3)?.values?.email,
    ).toBe('robin@example.org');
    expect(await env.ownerDb.select().from(file).where(inArray(file.id, fileIds))).toEqual([]);
    for (const key of fileKeys) expect(await env.storage.get(key)).toBeNull();

    const ledger = await env.storage.get(`erasures/${result.erasureId}.json`);
    const entry = JSON.parse(ledger?.toString() ?? '{}');
    expect(entry).toMatchObject({ erasureId: result.erasureId, orgId: org.orgId });
    expect(entry.credentialIds.sort()).toEqual([...result.erased].sort());
    expect(tracesIn(entry)).toEqual([]);
  });

  it('leaves nothing readable about them in the audit log, which stays whole', async () => {
    const stored = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.orgId, org.orgId));
    expect(tracesIn(stored)).toEqual([]);
    const log = (await org.owner.get(`${org.api}/audit-events?limit=100`)).json() as AuditEventPage;
    expect(tracesIn(log)).toEqual([]);
    const issued = log.events.find(
      (event) => event.action === 'credential.issued' && event.target?.id === ids.c1,
    );
    expect(issued?.data).toMatchObject({ recipientDetails: 'erased', emailed: true });
    const claimed = log.events.find(
      (event) => event.action === 'credential.claimed' && event.target?.id === ids.c1,
    );
    expect(claimed).toMatchObject({ actor: { type: 'recipient', label: null }, ip: null });
    const erased = log.events.filter((event) => event.action === 'credential.erased');
    expect(erased.map((event) => event.target?.id).sort()).toEqual([...result.erased].sort());
    expect(erased.find((event) => event.target?.id === ids.c1)).toMatchObject({
      actor: { label: org.owner.email },
      data: { erasure: result.erasureId, revoked: true },
    });
    expect(log.events.filter((event) => event.action === 'batch.rows_erased')).toHaveLength(2);

    for (const format of ['csv', 'jsonl']) {
      const exported = await org.owner.get(`${org.api}/exports/audit-events.${format}`);
      expect(exported.statusCode).toBe(200);
      expect(tracesIn(exported.body)).toEqual([]);
    }
  });

  it('shows the issuer a tombstone, and finds nothing by name or address', async () => {
    const tombstone = await details(ids.c1);
    expect(tombstone).toMatchObject({
      recipient: null,
      document: null,
      status: 'revoked',
      customFields: {},
      evidence: [],
      erasedBy: { label: org.owner.email },
    });
    expect(tombstone.erasedAt).not.toBeNull();
    expect(tombstone.emails.every((email) => email.to === null)).toBe(true);
    expect(tracesIn(tombstone)).toEqual([]);

    const search = (await org.owner.get(`${org.api}/credentials?q=quinn`)).json() as CredentialPage;
    expect(search.credentials).toEqual([]);
    for (const format of ['csv', 'jsonl']) {
      const exported = await org.owner.get(`${org.api}/exports/credentials.${format}`);
      expect(exported.body).toContain(ids.c1);
      expect(tracesIn(exported.body)).toEqual([]);
    }
    const results = await org.owner.get(`${org.api}/batches/${awardedBatch}/results.csv`);
    expect(results.body).toMatch(/\n2,,,erased,/);
    expect(results.body).toContain(SAM.email);
    const rows = (
      await org.owner.get(`${org.api}/batches/${draftBatch}/rows?limit=10`)
    ).json() as BatchRowPage;
    expect(rows.rows.find((row) => row.rowNumber === 2)).toMatchObject({
      values: null,
      erasedAt: expect.any(String),
    });
  });

  it('answers 410 Gone at the badge’s address, for pages, verifiers and downloads', async () => {
    const page = await anonymous(`/credentials/${ids.c1}`, { accept: 'text/html' });
    expect(page.statusCode).toBe(410);
    expect(page.body).toContain('This badge is no longer available');
    expect(page.body).toContain('Example Cyber Academy');
    expect(page.headers['x-robots-tag']).toBe('noindex');
    expect(tracesIn(page.body)).toEqual([]);

    const json = await anonymous(`/credentials/${ids.c1}`);
    expect(json.statusCode).toBe(410);
    expect(json.json()).toMatchObject({ code: 'credential_erased', status: 410 });

    for (const url of [
      `/credentials/${ids.c1}/badge.png`,
      `/credentials/${ids.c1}/badge.svg`,
      `/credentials/${ids.c1}/credential.json`,
      `/credentials/${ids.c1}/certificate`,
      `/credentials/${ids.c1}?t=${claimToken}`,
    ]) {
      expect((await anonymous(url)).statusCode, url).toBe(410);
    }
    const hide = await env.app.inject({
      method: 'POST',
      url: `/credentials/${ids.c1}/visibility`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE_URL },
      payload: 'visibility=hidden',
    });
    expect(hide.statusCode).toBe(410);

    const byUrl = await env.app.inject({
      method: 'POST',
      url: '/api/v1/verify',
      payload: { url: `${BASE_URL}/credentials/${ids.c1}` },
    });
    expectProblem(byUrl, 410, 'credential_erased');
  });

  it('ignores the provider’s later events for erased emails', async () => {
    const before = await env.ownerDb.select().from(auditEvent);
    const applied = await applySendGridEvents(env.db, [
      {
        event: 'spamreport',
        timestamp: Math.floor(Date.now() / 1000),
        sg_event_id: 'late-1',
        [TRACKING_ARG]: messageIds[0],
      },
    ]);
    expect(applied).toBe(0);
    expect(await env.ownerDb.select().from(auditEvent)).toHaveLength(before.length);
  });

  it('refuses to erase twice, and changes nothing else', async () => {
    expectProblem(
      await org.owner.post(`${org.api}/credentials/${ids.c4}/erasure`),
      409,
      'already_erased',
    );
    const preview = (
      await org.owner.get(`${org.api}/credentials/${ids.c1}/erasure`)
    ).json() as RecipientErasurePreview;
    expect(preview.recipient).toBeNull();
    expect(preview.credentials.every((row) => row.erased)).toBe(true);
    expectProblem(
      await org.owner.post(`${org.api}/credentials/${ids.c4}/revoke`, { reason: 'x' }),
      409,
      'already_revoked',
    );
    expectProblem(
      await org.owner.post(`${org.api}/credentials/${ids.c4}/reissue`, {}),
      409,
      'already_revoked',
    );
    expectProblem(await org.owner.post(`${org.api}/credentials/${ids.c4}/resend`), 409, 'conflict');
  });

  it('never awards an erased row of a draft batch', async () => {
    const confirmed = await org.owner.post(`${org.api}/batches/${draftBatch}/confirm`);
    expect(confirmed.statusCode, confirmed.body).toBeLessThan(300);
    expect(await issueBatch(workerServices(env), draftBatch)).toBe('done');
    const awarded = await env.ownerDb
      .select()
      .from(credential)
      .where(eq(credential.batchId, draftBatch));
    expect(awarded.map((row) => row.recipientEmail)).toEqual(['robin@example.org']);
    const [row] = await env.ownerDb
      .select()
      .from(issuanceBatchRow)
      .where(and(eq(issuanceBatchRow.batchId, draftBatch), eq(issuanceBatchRow.rowNumber, 2)));
    expect(row).toMatchObject({ status: 'skipped', errorCode: 'erased', values: null });
  });

  it('can award the same address again later', async () => {
    const again = await awardTo(org, QUINN);
    expect((await details(again)).recipient).toEqual(QUINN);
  });

  it('erases again after a restore from a backup taken before the erasure', async () => {
    const riley = await awardTo(org, { name: 'Riley Restore', email: 'riley@example.org' });
    const [before] = await env.ownerDb.select().from(credential).where(eq(credential.id, riley));
    if (!before) throw new Error('no credential');
    const erased = await org.owner.post(`${org.api}/credentials/${riley}/erasure`);
    expect(erased.statusCode, erased.body).toBe(200);

    // The restored database has Riley's badge as it was before the erasure.
    const { id: _id, ...restored } = before;
    await env.ownerDb.update(credential).set(restored).where(eq(credential.id, riley));
    expect((await details(riley)).recipient?.name).toBe('Riley Restore');

    const actor = { type: 'system' as const, label: 'cli' };
    const first = await reapplyErasures({ db: env.db, storage: env.storage }, actor);
    expect(first.reapplied).toBe(1);
    expect(first.entries).toBeGreaterThanOrEqual(2);
    const [after] = await env.ownerDb.select().from(credential).where(eq(credential.id, riley));
    expect(after).toMatchObject({ recipientName: null, document: null, status: 'revoked' });
    expect(after?.erasedAt).toBeInstanceOf(Date);
    expect((await reapplyErasures({ db: env.db, storage: env.storage }, actor)).reapplied).toBe(0);
  });
});

describe('sealing audit events written before migration 0006', () => {
  it('seals recipient details once, as the owner, and the log stays append-only', async () => {
    const legacy = await issuingOrg(env, 'Legacy Academy');
    const lee = await awardTo(legacy, { name: 'Lee Legacy', email: 'lee@example.org' });
    const ownerId = ((await legacy.owner.me()) as { user: { id: string } }).user.id;
    const event = (values: Partial<typeof auditEvent.$inferInsert>) => ({
      orgId: legacy.orgId,
      actorType: 'user' as const,
      actorId: ownerId,
      actorLabel: legacy.owner.email,
      action: 'credential.issued',
      targetType: 'credential',
      targetId: lee,
      data: {},
      ...values,
    });
    // As M3–M5 wrote them: plain names, addresses, reasons and searches.
    const inserted = await env.ownerDb
      .insert(auditEvent)
      .values([
        event({
          data: { recipientName: 'Lee Legacy', recipientEmail: 'lee@example.org', emailed: true },
        }),
        event({
          action: 'credential.claimed',
          actorType: 'recipient',
          actorId: null,
          actorLabel: 'Lee Legacy',
          ip: '203.0.113.9',
          userAgent: 'LegacyBrowser/1.0',
        }),
        event({
          action: 'credentials.exported',
          targetType: null,
          targetId: null,
          data: { format: 'csv', filters: { q: 'lee@example.org', status: 'valid' } },
        }),
        event({
          action: 'email.bounced',
          actorType: 'system',
          actorId: null,
          actorLabel: 'credforge',
          data: { emailId: 'x', kind: 'award', reason: '550 <lee@example.org> unknown' },
        }),
        event({ action: 'org.updated', targetType: null, targetId: null, data: { name: 'Lee' } }),
      ])
      .returning({ id: auditEvent.id });
    await env.ownerDb
      .delete(instanceSettings)
      .where(eq(instanceSettings.key, 'audit_recipient_details_sealed_at'));

    expect(await sealEarlierAuditEvents(env.ownerPool)).toBe(4);
    expect(await sealEarlierAuditEvents(env.ownerPool)).toBeNull();

    const rows = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(
        inArray(
          auditEvent.id,
          inserted.map((row) => row.id),
        ),
      )
      .orderBy(auditEvent.id);
    expect(rows.map((row) => row.data)).toEqual([
      { emailed: true, sealed: expect.any(String) },
      { sealed: expect.any(String) },
      { format: 'csv', filters: { status: 'valid', search: true } },
      { emailId: 'x', kind: 'award', sealed: expect.any(String) },
      { name: 'Lee' },
    ]);
    expect(rows[1]).toMatchObject({ actorLabel: null, ip: null, userAgent: null });
    expect(JSON.stringify(rows.slice(0, 4))).not.toMatch(/lee@|lee legacy|legacybrowser/i);
    const [note] = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.orgId, legacy.orgId),
          eq(auditEvent.action, 'audit.recipient_details_sealed'),
        ),
      );
    expect(note).toMatchObject({ actorType: 'system', data: { events: 4 } });

    // The trigger is back on: even the owner can't change the log.
    await expect(
      env.ownerPool.query(`update audit_event set action = 'x' where id = $1`, [rows[0]?.id]),
    ).rejects.toThrow(/append-only/);

    // Read back as they were, until Lee's data is erased.
    const read = async () =>
      (
        (await legacy.owner.get(`${legacy.api}/audit-events?limit=100`)).json() as AuditEventPage
      ).events.filter((row) => inserted.some((each) => each.id === row.id));
    const opened = await read();
    expect(opened.find((row) => row.action === 'credential.issued')?.data).toMatchObject({
      recipientName: 'Lee Legacy',
      recipientEmail: 'lee@example.org',
    });
    expect(opened.find((row) => row.action === 'credential.claimed')).toMatchObject({
      actor: { label: 'Lee Legacy' },
      ip: '203.0.113.9',
    });
    expect(String(opened.find((row) => row.action === 'email.bounced')?.data.reason)).toContain(
      'lee@example.org',
    );
    await legacy.owner.post(`${legacy.api}/credentials/${lee}/erasure`);
    expect(JSON.stringify(await read())).not.toMatch(/lee@|lee legacy|legacybrowser/i);
  });
});
