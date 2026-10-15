import type { BatchDetails, BatchRowPage, CredentialPage } from '@credforge/contracts';
import {
  and,
  auditEvent,
  credential,
  emailMessage,
  eq,
  file,
  issuanceBatch,
  issuanceBatchRow,
  organization,
} from '@credforge/db';
import { verifyCredential } from '@credforge/ob3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueBatch } from '../../src/batches/service';
import { createLocalResolvers } from '../../src/verify/local';
import { expectProblem, newUser, type TestClient } from './support/client';
import { BASE_URL, createTestEnvironment, type TestEnvironment } from './support/harness';
import { awardTo, type IssuingOrg, issuingOrg, workerServices } from './support/issuing';

let env: TestEnvironment;
let org: IssuingOrg;

const csv = (lines: string[]) => Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');

async function upload(
  body: Buffer,
  options: { achievementId?: string; fileName?: string; as?: TestClient; type?: string } = {},
) {
  const query = new URLSearchParams({
    achievementId: options.achievementId ?? org.achievementId,
    fileName: options.fileName ?? 'learners.csv',
  });
  return (options.as ?? org.owner).upload(
    `${org.api}/batches?${query}`,
    body,
    options.type ?? 'text/csv',
    'POST',
  );
}

async function created(body: Buffer, options?: Parameters<typeof upload>[1]) {
  const response = await upload(body, options);
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as BatchDetails;
}

const details = async (id: string) =>
  (await org.owner.get(`${org.api}/batches/${id}`)).json() as BatchDetails;

async function rows(id: string, query = '') {
  return ((await org.owner.get(`${org.api}/batches/${id}/rows${query}`)).json() as BatchRowPage)
    .rows;
}

beforeAll(async () => {
  env = await createTestEnvironment({ SIGNUP_MODE: 'open', DEFAULT_ORG_DAILY_SEND_LIMIT: '40' });
  org = await issuingOrg(env);
});
afterAll(async () => {
  await env?.close();
});

describe('uploading a file', () => {
  it('offers a template with the columns it recognizes', async () => {
    const response = await org.owner.get(`${org.api}/batches/template.csv`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toContain('credforge-award-template.csv');
    expect(response.body).toBe('﻿Name,Email,Award date,Expiry date,Evidence link\r\n');
  });

  let batchId: string;

  it('recognizes the columns and checks every row', async () => {
    await awardTo(org, { name: 'Already Here', email: 'holder@example.org' });
    const batch = await created(
      csv([
        'Full name,E-mail,Completion date,Cohort',
        'Ada Lovelace,ada@example.org,2026-01-15,Fall',
        'Grace Hopper,GRACE@example.org,,Fall',
        'Alan Turing,alan@example.org,2026/2/1,Spring',
        'No Address,not-an-email,,Fall',
        ',nobody@example.org,,Fall',
        'Ada Again,ada@example.org,,Fall',
        'Already Here,holder@example.org,,Spring',
        'Time Traveller,future@example.org,2999-01-01,Spring',
      ]),
    );
    batchId = batch.id;
    expect(batch).toMatchObject({
      status: 'draft',
      source: 'csv',
      fileName: 'learners.csv',
      hasHeader: true,
      totalRows: 8,
      options: { sendEmail: true, awardExisting: false },
      counts: { ready: 3, invalid: 3, duplicate: 1, existing: 1, pending: 0, issued: 0 },
      plan: { toAward: 3, toSkip: 5, emails: 3, sendLimit: { limit: 40 } },
    });
    expect(batch.columns.map((column) => [column.header, column.target])).toEqual([
      ['Full name', 'name'],
      ['E-mail', 'email'],
      ['Completion date', 'issuedOn'],
      ['Cohort', 'custom'],
    ]);
    expect(batch.columns[0]?.samples).toEqual(['Ada Lovelace', 'Grace Hopper', 'Alan Turing']);

    const invalid = await rows(batchId, '?validation=invalid');
    expect(invalid.map((row) => [row.rowNumber, row.issues[0]?.message])).toEqual([
      [5, '“not-an-email” isn’t a valid email address'],
      [6, 'The name is missing'],
      [9, 'The award date is in the future'],
    ]);
    const [duplicate] = await rows(batchId, '?validation=duplicate');
    expect(duplicate?.issues[0]?.message).toBe('The same email address as row 2');
    const [existing] = await rows(batchId, '?validation=existing');
    expect(existing?.values?.email).toBe('holder@example.org');

    const [file_] = await env.ownerDb.select().from(file).where(eq(file.subjectId, batchId));
    expect(file_).toMatchObject({
      kind: 'csv_import',
      visibility: 'private',
      mimeType: 'text/csv',
    });
    expect(file_?.key).toBe(`orgs/${org.orgId}/imports/${batchId}.csv`);
  });

  it('changes the mapping and options while it is a draft', async () => {
    const response = await org.owner.patch(`${org.api}/batches/${batchId}`, {
      columns: ['name', 'email', 'issuedOn', 'ignore'],
      awardExisting: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    const batch = response.json() as BatchDetails;
    expect(batch.columns[3]?.target).toBe('ignore');
    expect(batch.plan).toMatchObject({ toAward: 4, emails: 4 });
    const [ada] = await rows(batchId, '?validation=ready&limit=1');
    expect(ada?.values?.custom).toEqual({});

    const bad = await org.owner.patch(`${org.api}/batches/${batchId}`, { columns: ['name'] });
    expectProblem(bad, 400, 'validation_failed');
    const missing = await org.owner.patch(`${org.api}/batches/${batchId}`, {
      columns: ['name', 'ignore', 'issuedOn', 'ignore'],
    });
    expect((missing.json() as BatchDetails).counts.ready).toBe(0);
    await org.owner.patch(`${org.api}/batches/${batchId}`, {
      columns: ['name', 'email', 'issuedOn', 'custom'],
    });
  });

  it('issues the confirmed rows once each, with one email each', async () => {
    const confirmed = await org.owner.post(`${org.api}/batches/${batchId}/confirm`);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({
      status: 'queued',
      counts: { pending: 4, skipped: 4 },
    });
    expectProblem(
      await org.owner.post(`${org.api}/batches/${batchId}/confirm`),
      409,
      'batch_not_draft',
    );
    expectProblem(
      await org.owner.patch(`${org.api}/batches/${batchId}`, { sendEmail: false }),
      409,
      'batch_not_draft',
    );

    expect(await issueBatch(workerServices(env), batchId)).toBe('done');
    const batch = await details(batchId);
    expect(batch).toMatchObject({
      status: 'completed',
      counts: { issued: 4, skipped: 4, failed: 0, pending: 0 },
    });
    expect(batch.finishedAt).not.toBeNull();

    const issued = await env.ownerDb
      .select()
      .from(credential)
      .where(eq(credential.batchId, batchId));
    expect(issued).toHaveLength(4);
    expect(issued.map((row) => row.recipientEmail).sort()).toEqual([
      'ada@example.org',
      'alan@example.org',
      'grace@example.org',
      'holder@example.org',
    ]);
    const ada = issued.find((row) => row.recipientEmail === 'ada@example.org');
    expect(ada?.customFields).toEqual({ Cohort: 'Fall' });
    expect(ada?.validFrom.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(ada?.document).not.toHaveProperty('credentialSubject.Cohort');
    const check = await verifyCredential(ada?.document, createLocalResolvers(env.db, BASE_URL));
    expect(check.verified, JSON.stringify(check.checks)).toBe(true);

    const emails = await env.ownerDb
      .select()
      .from(emailMessage)
      .where(and(eq(emailMessage.orgId, org.orgId), eq(emailMessage.kind, 'award')));
    for (const row of issued) {
      expect(emails.filter((email) => email.credentialId === row.id)).toHaveLength(1);
    }

    // Running it again changes nothing.
    expect(await issueBatch(workerServices(env), batchId)).toBe('done');
    expect(
      await env.ownerDb.select().from(credential).where(eq(credential.batchId, batchId)),
    ).toHaveLength(4);

    const listed = (
      await org.owner.get(`${org.api}/credentials?batchId=${batchId}`)
    ).json() as CredentialPage;
    expect(listed.credentials).toHaveLength(4);
    expect(listed.credentials.every((item) => item.batchId === batchId)).toBe(true);

    const actions = (
      await env.ownerDb.select().from(auditEvent).where(eq(auditEvent.orgId, org.orgId))
    ).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(['batch.created', 'batch.confirmed']));
  });

  it('never issues a row twice, even if its status were lost', async () => {
    const [row] = await env.ownerDb
      .select()
      .from(issuanceBatchRow)
      // Alan's row; the results test below still expects Ada's row awarded.
      .where(and(eq(issuanceBatchRow.batchId, batchId), eq(issuanceBatchRow.rowNumber, 4)));
    if (row?.status !== 'issued') throw new Error('row 4 was not issued');
    const emailsBefore = await env.ownerDb.select().from(emailMessage);
    await env.ownerDb
      .update(issuanceBatchRow)
      .set({ status: 'pending', credentialId: null })
      .where(
        and(eq(issuanceBatchRow.batchId, batchId), eq(issuanceBatchRow.rowNumber, row.rowNumber)),
      );
    await env.ownerDb
      .update(issuanceBatch)
      .set({ status: 'running' })
      .where(eq(issuanceBatch.id, batchId));

    await issueBatch(workerServices(env), batchId);
    const issued = await env.ownerDb
      .select()
      .from(credential)
      .where(eq(credential.batchId, batchId));
    expect(issued).toHaveLength(4);
    expect(await env.ownerDb.select().from(emailMessage)).toHaveLength(emailsBefore.length);
    const [again] = await env.ownerDb
      .select()
      .from(issuanceBatchRow)
      .where(
        and(eq(issuanceBatchRow.batchId, batchId), eq(issuanceBatchRow.rowNumber, row.rowNumber)),
      );
    expect(again?.status).toBe('failed');
  });

  it('downloads results with each credential’s URL or the reason, escaped for spreadsheets', async () => {
    const response = await org.owner.get(`${org.api}/batches/${batchId}/results.csv`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain('results-learners.csv');
    const lines = response.body.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('Row,Name,Email,Result,Credential URL,Problem,Cohort');
    expect(lines).toHaveLength(9);
    expect(lines[1]).toMatch(
      new RegExp(
        `^2,Ada Lovelace,ada@example\\.org,awarded,${BASE_URL}/credentials/[0-9a-f-]{36},,Fall$`,
      ),
    );
    expect(lines[4]).toBe(
      '5,No Address,not-an-email,skipped,,“not-an-email” isn’t a valid email address,Fall',
    );

    const evil = await created(
      csv(['Name,Email', '=HYPERLINK("https://evil.example"),eve@example.org']),
    );
    const evilCsv = (await org.owner.get(`${org.api}/batches/${evil.id}/results.csv`)).body;
    expect(evilCsv).toContain(`"'=HYPERLINK(""https://evil.example"")"`);
  });
});

describe('file problems', () => {
  it('refuses files over 5 MB and over 10,000 rows, and files that aren’t usable', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');
    expectProblem(await upload(big), 413, 'file_too_large');
    expect((await upload(big)).json()).toMatchObject({ detail: 'Files can be at most 5 MB.' });

    const many = csv([
      'Name,Email',
      ...Array.from({ length: 10_001 }, (_, i) => `P${i},p${i}@example.org`),
    ]);
    const tooMany = await upload(many);
    expectProblem(tooMany, 400, 'invalid_csv');
    expect(tooMany.json()).toMatchObject({
      detail: expect.stringContaining('more than 10,000 rows'),
    });

    expectProblem(await upload(Buffer.from('Name,Email\r\n')), 400, 'invalid_csv');
    expectProblem(await upload(Buffer.alloc(0)), 400, 'invalid_csv');
    expectProblem(
      await upload(csv(['Name,Email', 'A,a@example.org']), { achievementId: crypto.randomUUID() }),
      400,
      'validation_failed',
    );
  });

  it('accepts exactly 10,000 rows', async () => {
    const lines = [
      'Name,Email',
      ...Array.from({ length: 10_000 }, (_, i) => `P${i},p${i}@example.org`),
    ];
    const batch = await created(csv(lines));
    expect(batch.totalRows).toBe(10_000);
    expect(batch.counts.ready).toBe(10_000);
    expect((await org.owner.delete(`${org.api}/batches/${batch.id}`)).statusCode).toBe(204);
  });

  it('reads a file without a header line, and can be told it has one', async () => {
    const batch = await created(
      csv(['Ada Lovelace,ada2@example.org', 'Alan Turing,alan2@example.org']),
    );
    expect(batch).toMatchObject({ hasHeader: false, totalRows: 2, counts: { ready: 2 } });
    expect(batch.columns.map((column) => [column.header, column.target])).toEqual([
      ['Column 1', 'name'],
      ['Column 2', 'email'],
    ]);
    const toggled = (
      await org.owner.patch(`${org.api}/batches/${batch.id}`, { hasHeader: true })
    ).json() as BatchDetails;
    expect(toggled).toMatchObject({ hasHeader: true, totalRows: 1 });
    expect(toggled.columns.map((column) => column.header)).toEqual([
      'Ada Lovelace',
      'ada2@example.org',
    ]);
  });

  it('deletes a draft and its file', async () => {
    const batch = await created(csv(['Name,Email', 'A,a@example.org']));
    const response = await org.owner.delete(`${org.api}/batches/${batch.id}`);
    expect(response.statusCode).toBe(204);
    expect(await env.ownerDb.select().from(file).where(eq(file.subjectId, batch.id))).toEqual([]);
    expect(await env.storage.get(`orgs/${org.orgId}/imports/${batch.id}.csv`)).toBeNull();
    expect((await org.owner.get(`${org.api}/batches/${batch.id}`)).statusCode).toBe(404);
  });
});

describe('rules', () => {
  it('takes JSON rows from the API and checks them the same way', async () => {
    const response = await org.owner.post(`${org.api}/batches`, {
      achievementId: org.achievementId,
      rows: [
        {
          name: 'Katherine Johnson',
          email: 'katherine@example.org',
          custom: { 'Student ID': '42' },
        },
        { name: 'Bad', email: 'bad' },
      ],
      sendEmail: false,
    });
    expect(response.statusCode, response.body).toBe(201);
    const batch = response.json() as BatchDetails;
    expect(batch).toMatchObject({
      source: 'api',
      totalRows: 2,
      counts: { ready: 1, invalid: 1 },
      plan: { toAward: 1, emails: 0 },
    });
    const [ready] = await rows(batch.id, '?validation=ready');
    expect(ready?.values?.custom).toEqual({ 'Student ID': '42' });
  });

  it('refuses a batch whose emails would pass the daily cap, unless sent without email', async () => {
    const lines = [
      'Name,Email',
      ...Array.from({ length: 45 }, (_, i) => `Cap ${i},cap${i}@example.org`),
    ];
    const batch = await created(csv(lines));
    expect(batch.plan.sendLimit.remaining).toBeLessThan(45);
    const refused = await org.owner.post(`${org.api}/batches/${batch.id}/confirm`);
    expectProblem(refused, 429, 'send_limit_reached');
    expect(refused.json()).toMatchObject({
      detail: expect.stringContaining('would send 45 emails'),
    });

    await org.owner.patch(`${org.api}/batches/${batch.id}`, { sendEmail: false });
    expect((await org.owner.post(`${org.api}/batches/${batch.id}/confirm`)).statusCode).toBe(200);
    expect(await issueBatch(workerServices(env), batch.id)).toBe('done');
    expect((await details(batch.id)).counts.issued).toBe(45);
  });

  it('stops when the org is suspended part way', async () => {
    const batch = await created(
      csv(['Name,Email', 'S One,s1@example.org', 'S Two,s2@example.org']),
    );
    await org.owner.patch(`${org.api}/batches/${batch.id}`, { sendEmail: false });
    await org.owner.post(`${org.api}/batches/${batch.id}/confirm`);
    await env.ownerDb
      .update(organization)
      .set({ status: 'suspended' })
      .where(eq(organization.id, org.orgId));
    try {
      expect(await issueBatch(workerServices(env), batch.id)).toBe('done');
      const stopped = await details(batch.id);
      expect(stopped).toMatchObject({ status: 'failed', counts: { failed: 2, issued: 0 } });
      expect(stopped.error).toBe('This organization can’t award badges.');
      const [row] = await rows(batch.id);
      expect(row?.error).toEqual({
        code: 'org_inactive',
        message: 'This organization can’t award badges.',
      });
    } finally {
      await env.ownerDb
        .update(organization)
        .set({ status: 'active' })
        .where(eq(organization.id, org.orgId));
    }
  });

  it('marks non-members as not allowed while the org waits for approval', async () => {
    const pending = await issuingOrg(env, 'Pending Academy');
    await env.ownerDb
      .update(organization)
      .set({ status: 'pending' })
      .where(eq(organization.id, pending.orgId));
    const response = await pending.owner.upload(
      `${pending.api}/batches?achievementId=${pending.achievementId}`,
      csv(['Name,Email', `Owner,${pending.owner.email}`, 'Stranger,stranger@example.org']),
      'text/csv',
      'POST',
    );
    const batch = response.json() as BatchDetails;
    expect(batch.counts).toMatchObject({ ready: 1, invalid: 1 });
    const invalid = (
      (
        await pending.owner.get(`${pending.api}/batches/${batch.id}/rows?validation=invalid`)
      ).json() as BatchRowPage
    ).rows;
    expect(invalid[0]?.issues[0]?.message).toMatch(
      /Until a platform admin approves your organization/,
    );
  });

  it('lets only people who can award create and confirm batches', async () => {
    const viewer = await newUser(env, { twoFactor: false });
    await org.owner.post(`${org.api}/invitations`, { email: viewer.email, role: 'viewer' });
    const invite = env.outbox.messages.filter((message) => message.to === viewer.email).at(-1);
    const token = invite?.text.match(/\/invite\/(\S+)/)?.[1];
    await viewer.post(`/api/v1/invitations/${token}/accept`);
    expectProblem(
      await upload(csv(['Name,Email', 'A,a@example.org']), { as: viewer }),
      403,
      'forbidden',
    );
    expect((await viewer.get(`${org.api}/batches`)).statusCode).toBe(200);
  });
});
