import { createHash, randomUUID } from 'node:crypto';
import {
  BATCH_LIMITS,
  type BatchColumnTarget,
  type BatchCounts,
  type BatchDetails,
  type BatchRow,
  type BatchSummary,
  type createBatchFromRowsInput,
  type updateBatchInput,
} from '@credforge/contracts';
import {
  achievement,
  and,
  apiKey,
  asc,
  type BatchColumn,
  type BatchRowIssue,
  type BatchRowValues,
  credential,
  type Database,
  emailMessage,
  eq,
  file,
  gt,
  gte,
  inArray,
  isNull,
  issuanceBatch,
  issuanceBatchRow,
  lt,
  organization,
  type Queryable,
  sql,
  user,
} from '@credforge/db';
import type { z } from 'zod';
import { ApiError, notFound } from '../api/errors';
import { recordAudit } from '../audit/audit';
import {
  type AwardActor,
  type AwardServices,
  assertOrgCanIssue,
  awardInTransaction,
  credentialUrl,
  memberAddresses,
  type ParsedAward,
  PENDING_ORG_RECIPIENT_RULE,
  type RequestInfo,
} from '../credentials/service';
import type { Storage } from '../files/storage';
import type { JobQueue } from '../jobs/enqueue';
import { effectiveDailySendLimit } from '../orgs/service';
import {
  CSV_BOM,
  CsvError,
  columnNames,
  csvLine,
  detectColumns,
  looksLikeHeader,
  mappingProblems,
  mapRow,
  parseCsv,
} from './csv';

export type BatchRowRecord = typeof issuanceBatchRow.$inferSelect;
export type BatchRecord = typeof issuanceBatch.$inferSelect;

export interface BatchServices extends AwardServices {
  storage: Storage;
  jobs?: JobQueue;
}

const INSERT_CHUNK = 1000;
/** Problem codes after which no further row can succeed: the batch stops. */
const STOPPING_CODES = new Set([
  'org_inactive',
  'achievement_not_active',
  'issuer_not_ready',
  'send_limit_reached',
]);

const invalidCsv = (detail: string) =>
  new ApiError(400, 'invalid_csv', 'Can’t use this file', detail);

/** The first row number holding a recipient: 2 when line 1 is the header. */
const firstDataRow = (batch: Pick<BatchRecord, 'hasHeader' | 'source'>) =>
  batch.source === 'csv' && batch.hasHeader ? 2 : 1;

/** Column names for a CSV batch: its first line, or "Column 1", … when it has none. */
function headersFor(firstCells: string[], width: number, hasHeader: boolean): string[] {
  const generic = columnNames(width);
  return hasHeader ? generic.map((name, index) => firstCells[index]?.trim() || name) : generic;
}

async function findAchievement(db: Queryable, orgId: string, achievementId: string) {
  const [row] = await db
    .select({ id: achievement.id, status: achievement.status, name: achievement.name })
    .from(achievement)
    .where(and(eq(achievement.orgId, orgId), eq(achievement.id, achievementId)));
  if (!row) {
    throw new ApiError(400, 'validation_failed', 'Check the highlighted fields', undefined, {
      achievementId: 'Choose an achievement',
    });
  }
  return row;
}

async function insertRows(
  tx: Queryable,
  batchId: string,
  orgId: string,
  records: string[][],
): Promise<void> {
  for (let start = 0; start < records.length; start += INSERT_CHUNK) {
    await tx.insert(issuanceBatchRow).values(
      records.slice(start, start + INSERT_CHUNK).map((cells, offset) => ({
        batchId,
        orgId,
        rowNumber: start + offset + 1,
        cells,
      })),
    );
  }
}

/**
 * A draft batch from an uploaded CSV file (design plan §8.3). The file is read with a streaming
 * parser and limits (10,000 rows, 5 MB, checked before parsing), its columns are recognized,
 * every row is checked, and the file is kept privately for 30 days.
 */
export async function createCsvBatch(
  services: BatchServices,
  target: { orgId: string },
  input: { achievementId: string; fileName: string | null; bytes: Buffer },
  creator: AwardActor,
  request: RequestInfo,
): Promise<string> {
  const { db, storage } = services;
  await findAchievement(db, target.orgId, input.achievementId);
  let records: string[][];
  try {
    records = await parseCsv(input.bytes);
  } catch (error) {
    if (error instanceof CsvError) throw invalidCsv(error.message);
    throw error;
  }
  const hasHeader = looksLikeHeader(records[0] ?? []);
  const dataRows = hasHeader ? records.length - 1 : records.length;
  if (dataRows === 0) throw invalidCsv('The file has column names but no rows of recipients.');
  if (dataRows > BATCH_LIMITS.maxRows) {
    throw invalidCsv(
      `The file has more than ${BATCH_LIMITS.maxRows.toLocaleString('en-US')} rows. Split it into smaller files.`,
    );
  }
  const width = Math.max(...records.map((record) => record.length));
  const headers = headersFor(records[0] ?? [], width, hasHeader);
  const data = hasHeader ? records.slice(1) : records;
  const targets = detectColumns(headers, data.slice(0, 50), hasHeader);
  const columns = headers.map((header, index) => ({
    header,
    target: targets[index] ?? 'custom',
  }));

  const id = randomUUID();
  const key = `orgs/${target.orgId}/imports/${id}.csv`;
  // The object first: a failed transaction leaves only an unreferenced import to clean up.
  await storage.put(key, input.bytes, 'text/csv');
  await db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(file)
      .values({
        orgId: target.orgId,
        kind: 'csv_import',
        subjectId: id,
        driver: storage.driver,
        bucket: storage.bucket,
        key,
        mimeType: 'text/csv',
        size: input.bytes.length,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        visibility: 'private',
        createdBy: creator.type === 'user' ? creator.id : null,
      })
      .returning({ id: file.id });
    await tx.insert(issuanceBatch).values({
      id,
      orgId: target.orgId,
      achievementId: input.achievementId,
      source: 'csv',
      fileId: stored?.id ?? null,
      fileName: input.fileName?.slice(0, 200) ?? null,
      hasHeader,
      columns,
      totalRows: dataRows,
      createdByType: creator.type,
      createdById: creator.id,
    });
    await insertRows(tx, id, target.orgId, records);
    await validateBatch(tx, target.orgId, id);
    await recordAudit(tx, {
      orgId: target.orgId,
      actor: creator,
      action: 'batch.created',
      target: { type: 'batch', id },
      data: {
        source: 'csv',
        fileName: input.fileName,
        rows: dataRows,
        achievementId: input.achievementId,
      },
      request,
    });
  });
  return id;
}

export type ParsedRowsBatch = z.output<typeof createBatchFromRowsInput>;

const API_FIELDS: {
  key: 'name' | 'email' | 'issuedOn' | 'expiresOn' | 'evidenceUrl';
  target: BatchColumnTarget;
}[] = [
  { key: 'name', target: 'name' },
  { key: 'email', target: 'email' },
  { key: 'issuedOn', target: 'issuedOn' },
  { key: 'expiresOn', target: 'expiresOn' },
  { key: 'evidenceUrl', target: 'evidenceUrl' },
];

/** A draft batch from JSON rows (the API). The rows are checked exactly like a file's. */
export async function createRowsBatch(
  services: BatchServices,
  target: { orgId: string },
  input: ParsedRowsBatch,
  creator: AwardActor,
  request: RequestInfo,
): Promise<string> {
  const { db } = services;
  await findAchievement(db, target.orgId, input.achievementId);
  const customKeys = [...new Set(input.rows.flatMap((row) => Object.keys(row.custom ?? {})))];
  if (customKeys.length > BATCH_LIMITS.maxCustomFields) {
    throw new ApiError(
      400,
      'validation_failed',
      'Too many custom fields',
      `Rows can have at most ${BATCH_LIMITS.maxCustomFields} custom fields.`,
    );
  }
  const columns: BatchColumn[] = [
    ...API_FIELDS.map((field) => ({ header: field.key, target: field.target })),
    ...customKeys.map((header) => ({ header, target: 'custom' as const })),
  ];
  const records = input.rows.map((row) => [
    ...API_FIELDS.map((field) => row[field.key] ?? ''),
    ...customKeys.map((key) => row.custom?.[key] ?? ''),
  ]);
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(issuanceBatch).values({
      id,
      orgId: target.orgId,
      achievementId: input.achievementId,
      source: 'api',
      hasHeader: false,
      columns,
      options: { sendEmail: input.sendEmail ?? true, awardExisting: input.awardExisting ?? false },
      totalRows: records.length,
      createdByType: creator.type,
      createdById: creator.id,
    });
    await insertRows(tx, id, target.orgId, records);
    await validateBatch(tx, target.orgId, id);
    await recordAudit(tx, {
      orgId: target.orgId,
      actor: creator,
      action: 'batch.created',
      target: { type: 'batch', id },
      data: { source: 'api', rows: records.length, achievementId: input.achievementId },
      request,
    });
  });
  return id;
}

async function lockBatch(tx: Queryable, orgId: string, batchId: string): Promise<BatchRecord> {
  const [batch] = await tx
    .select()
    .from(issuanceBatch)
    .where(and(eq(issuanceBatch.orgId, orgId), eq(issuanceBatch.id, batchId)))
    .for('update');
  if (!batch) throw notFound('Batch');
  return batch;
}

const notDraft = () =>
  new ApiError(
    409,
    'batch_not_draft',
    'Already confirmed',
    'This batch was confirmed, so it can’t be changed.',
  );

export type ParsedBatchUpdate = z.output<typeof updateBatchInput>;

/** Changes a draft: the achievement, whether line 1 is a header, the mapping, the options. */
export async function updateBatch(
  services: Pick<BatchServices, 'db'>,
  orgId: string,
  batchId: string,
  input: ParsedBatchUpdate,
): Promise<void> {
  await services.db.transaction(async (tx) => {
    const batch = await lockBatch(tx, orgId, batchId);
    if (batch.status !== 'draft') throw notDraft();
    if (input.achievementId) await findAchievement(tx, orgId, input.achievementId);

    let columns = batch.columns;
    let hasHeader = batch.hasHeader;
    if (batch.source === 'csv' && input.hasHeader !== undefined && input.hasHeader !== hasHeader) {
      hasHeader = input.hasHeader;
      const rows = await tx
        .select({ cells: issuanceBatchRow.cells })
        .from(issuanceBatchRow)
        .where(and(eq(issuanceBatchRow.batchId, batchId), isNull(issuanceBatchRow.erasedAt)))
        .orderBy(asc(issuanceBatchRow.rowNumber))
        .limit(51);
      const headers = headersFor(rows[0]?.cells ?? [], columns.length, hasHeader);
      const samples = rows.slice(hasHeader ? 1 : 0).map((row) => row.cells);
      const targets = detectColumns(headers, samples, hasHeader);
      columns = headers.map((header, index) => ({ header, target: targets[index] ?? 'custom' }));
    }
    if (input.columns) {
      if (input.columns.length !== columns.length) {
        throw new ApiError(400, 'validation_failed', 'Check the highlighted fields', undefined, {
          columns: `The file has ${columns.length} columns; choose what each one holds.`,
        });
      }
      if (batch.source === 'api') {
        throw new ApiError(400, 'validation_failed', 'Rows sent as JSON have fixed fields');
      }
      columns = columns.map((column, index) => ({
        header: column.header,
        target: input.columns?.[index] ?? column.target,
      }));
    }
    const totalRows =
      batch.source === 'csv'
        ? ((
            await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(issuanceBatchRow)
              .where(eq(issuanceBatchRow.batchId, batchId))
          )[0]?.count ?? 0)
        : batch.totalRows;
    await tx
      .update(issuanceBatch)
      .set({
        achievementId: input.achievementId ?? batch.achievementId,
        hasHeader,
        columns,
        totalRows: batch.source === 'csv' ? totalRows - (hasHeader ? 1 : 0) : totalRows,
        options: {
          sendEmail: input.sendEmail ?? batch.options.sendEmail,
          awardExisting: input.awardExisting ?? batch.options.awardExisting,
        },
        updatedAt: new Date(),
      })
      .where(eq(issuanceBatch.id, batchId));
    await validateBatch(tx, orgId, batchId);
  });
}

/**
 * Checks every row of a draft (the validation report): each row on its own (`mapRow`), then
 * across rows and against the database: the same email on an earlier row, people who already
 * hold the achievement, and, while the org waits for approval, addresses that aren't members'.
 */
export async function validateBatch(tx: Queryable, orgId: string, batchId: string): Promise<void> {
  const [batch] = await tx.select().from(issuanceBatch).where(eq(issuanceBatch.id, batchId));
  if (!batch) throw notFound('Batch');
  const [org] = await tx
    .select({ status: organization.status })
    .from(organization)
    .where(eq(organization.id, orgId));
  const pendingOrg = org?.status === 'pending';
  const allowed = pendingOrg ? await memberAddresses(tx, orgId) : null;
  const rows = await tx
    .select({ rowNumber: issuanceBatchRow.rowNumber, cells: issuanceBatchRow.cells })
    .from(issuanceBatchRow)
    .where(
      and(
        eq(issuanceBatchRow.batchId, batchId),
        gte(issuanceBatchRow.rowNumber, firstDataRow(batch)),
        isNull(issuanceBatchRow.erasedAt),
      ),
    )
    .orderBy(asc(issuanceBatchRow.rowNumber));

  const problems = mappingProblems(batch.columns);
  const now = new Date();
  const mapped = rows.map((row) => ({
    rowNumber: row.rowNumber,
    ...mapRow(row.cells, batch.columns, now),
  }));
  const emails = [
    ...new Set(mapped.filter((row) => row.issues.length === 0).map((row) => row.values.email)),
  ];
  const holders = new Set<string>();
  for (let start = 0; start < emails.length; start += INSERT_CHUNK) {
    const found = await tx
      .selectDistinct({ email: credential.recipientEmail })
      .from(credential)
      .where(
        and(
          eq(credential.orgId, orgId),
          eq(credential.achievementId, batch.achievementId),
          eq(credential.status, 'issued'),
          inArray(credential.recipientEmail, emails.slice(start, start + INSERT_CHUNK)),
        ),
      );
    for (const row of found) if (row.email) holders.add(row.email);
  }

  const firstSeen = new Map<string, number>();
  const results = mapped.map((row) => {
    const issues: BatchRowIssue[] = [
      ...problems.map((message) => ({ field: 'columns', message })),
      ...row.issues,
    ];
    let validation: 'ready' | 'invalid' | 'duplicate' | 'existing' = 'ready';
    if (issues.length > 0) validation = 'invalid';
    else if (allowed && !allowed.has(row.values.email)) {
      validation = 'invalid';
      issues.push({ field: 'email', message: PENDING_ORG_RECIPIENT_RULE });
    } else if (firstSeen.has(row.values.email)) {
      validation = 'duplicate';
      issues.push({
        field: 'email',
        message: `The same email address as row ${firstSeen.get(row.values.email)}`,
      });
    } else {
      firstSeen.set(row.values.email, row.rowNumber);
      if (holders.has(row.values.email)) {
        validation = 'existing';
        issues.push({ field: 'email', message: 'Already holds this achievement' });
      }
    }
    return { row_number: row.rowNumber, values: row.values, validation, issues };
  });

  for (let start = 0; start < results.length; start += INSERT_CHUNK) {
    const chunk = JSON.stringify(results.slice(start, start + INSERT_CHUNK));
    await tx.execute(sql`
      update ${issuanceBatchRow} as r
      set "values" = d."values", "validation" = d."validation", "issues" = d."issues"
      from jsonb_to_recordset(${chunk}::jsonb)
        as d("row_number" int, "values" jsonb, "validation" text, "issues" jsonb)
      where r."batch_id" = ${batchId} and r."row_number" = d."row_number"`);
  }
  // A header line isn't a recipient.
  if (firstDataRow(batch) === 2) {
    await tx
      .update(issuanceBatchRow)
      .set({ values: null, validation: 'invalid', issues: [] })
      .where(
        and(
          eq(issuanceBatchRow.batchId, batchId),
          eq(issuanceBatchRow.rowNumber, 1),
          isNull(issuanceBatchRow.erasedAt),
        ),
      );
  }
}

/** Award emails the org can still send in the next 24 hours; null when it has no limit. */
export async function remainingSends(
  db: Queryable,
  org: { id: string; dailySendLimit: number | null },
  defaultLimit: number,
): Promise<{ limit: number | null; remaining: number | null }> {
  const limit = effectiveDailySendLimit(org.dailySendLimit, defaultLimit);
  if (limit === null) return { limit: null, remaining: null };
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(emailMessage)
    .where(
      and(
        eq(emailMessage.orgId, org.id),
        eq(emailMessage.kind, 'award'),
        gt(emailMessage.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  return { limit, remaining: Math.max(0, limit - (row?.count ?? 0)) };
}

/**
 * Confirms a draft (design plan §8.3): checks it once more, refuses it if the emails would pass
 * the org's daily cap, marks the rows to award `pending` and the rest `skipped`, and queues the
 * job, all in one transaction. The worker then issues the rows in chunks.
 */
export async function confirmBatch(
  services: BatchServices,
  orgId: string,
  batchId: string,
  actor: AwardActor,
  request: RequestInfo,
): Promise<void> {
  const { config } = services;
  await services.db.transaction(async (tx) => {
    // The org lock first, as for awards: the send cap is counted under it.
    const [org] = await tx
      .select()
      .from(organization)
      .where(eq(organization.id, orgId))
      .for('update');
    if (!org) throw notFound('Organization');
    assertOrgCanIssue(org);
    const batch = await lockBatch(tx, orgId, batchId);
    if (batch.status !== 'draft') throw notDraft();
    const problems = mappingProblems(batch.columns);
    if (problems.length > 0) {
      throw new ApiError(
        400,
        'validation_failed',
        'Choose what the columns hold',
        problems.join(' '),
      );
    }
    const [target] = await tx
      .select({ status: achievement.status })
      .from(achievement)
      .where(eq(achievement.id, batch.achievementId));
    if (target?.status !== 'active') {
      throw new ApiError(
        409,
        'achievement_not_active',
        target?.status === 'draft'
          ? 'Publish the achievement first'
          : 'The achievement is archived',
        'Only a published achievement can be awarded.',
      );
    }
    await validateBatch(tx, orgId, batchId);

    const counts = (await countRows(tx, [batchId])).get(batchId) ?? emptyCounts();
    const toAward = counts.ready + (batch.options.awardExisting ? counts.existing : 0);
    if (toAward === 0) {
      throw new ApiError(
        409,
        'nothing_to_award',
        'Nothing to award',
        'No row in this batch can be awarded. Fix the file and upload it again.',
      );
    }
    if (batch.options.sendEmail) {
      const { limit, remaining } = await remainingSends(tx, org, config.defaultOrgDailySendLimit);
      if (limit !== null && remaining !== null && toAward > remaining) {
        throw new ApiError(
          429,
          'send_limit_reached',
          'Over the daily email limit',
          `This batch would send ${toAward.toLocaleString('en-US')} emails, but this organization can send ${remaining.toLocaleString('en-US')} more in the next 24 hours (its limit is ${limit.toLocaleString('en-US')}). Award fewer people at once, award without email, or ask the people who run this credforge site to raise the limit.`,
        );
      }
    }

    const first = firstDataRow(batch);
    const awarded = sql.raw(batch.options.awardExisting ? `('ready', 'existing')` : `('ready')`);
    await tx.execute(sql`
      update ${issuanceBatchRow}
      set "status" = case when "validation" in ${awarded} then 'pending' else 'skipped' end,
          "error_code" = case when "validation" in ${awarded} then null else "validation" end,
          "error_message" = case when "validation" in ${awarded} then null
                                 else coalesce("issues"->0->>'message', 'Not awarded') end
      where "batch_id" = ${batchId} and "row_number" >= ${first} and "erased_at" is null`);
    const now = new Date();
    await tx
      .update(issuanceBatch)
      .set({
        status: 'queued',
        confirmedAt: now,
        confirmedByType: actor.type,
        confirmedById: actor.id,
        updatedAt: now,
      })
      .where(eq(issuanceBatch.id, batchId));
    await recordAudit(tx, {
      orgId,
      actor,
      action: 'batch.confirmed',
      target: { type: 'batch', id: batchId },
      data: {
        rows: batch.totalRows,
        toAward,
        skipped: batch.totalRows - toAward,
        sendEmail: batch.options.sendEmail,
        achievementId: batch.achievementId,
      },
      request,
    });
    await services.jobs?.issueBatch(batchId, { tx });
  });
}

/** Deletes a draft and its uploaded file. */
export async function deleteBatch(
  services: Pick<BatchServices, 'db' | 'storage'>,
  orgId: string,
  batchId: string,
  actor: AwardActor,
  request: RequestInfo,
): Promise<void> {
  const fileRow = await services.db.transaction(async (tx) => {
    const batch = await lockBatch(tx, orgId, batchId);
    if (batch.status !== 'draft') throw notDraft();
    await tx.delete(issuanceBatch).where(eq(issuanceBatch.id, batchId));
    const [stored] = batch.fileId
      ? await tx.delete(file).where(eq(file.id, batch.fileId)).returning()
      : [];
    await recordAudit(tx, {
      orgId,
      actor,
      action: 'batch.deleted',
      target: { type: 'batch', id: batchId },
      data: { fileName: batch.fileName, rows: batch.totalRows },
      request,
    });
    return stored;
  });
  if (fileRow) await services.storage.delete(fileRow.key);
}

// ---- issuing (the worker) ----

export interface IssueChunkOptions {
  /** Stop starting new rows after this long; the job queues itself to carry on. */
  budgetMs?: number;
}

function failureOf(error: unknown): { code: string; message: string } | null {
  if (error instanceof ApiError) {
    const fields = error.errors ? Object.values(error.errors).join(' ') : '';
    return {
      code: error.code,
      message: [error.detail ?? error.title, fields].filter(Boolean).join(' '),
    };
  }
  return null;
}

/** Connection drops, deadlocks and the like: the job should retry, the row stays pending. */
function isTransient(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code !== 'string') return false;
  return (
    /^(08|40|53|57)/.test(code) ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(code)
  );
}

/** Whoever confirmed the batch (a member or an API key): the worker awards on their behalf. */
async function batchActor(db: Queryable, batch: BatchRecord): Promise<AwardActor> {
  const confirmed = batch.confirmedById !== null;
  const id = (confirmed ? batch.confirmedById : batch.createdById) ?? '';
  const type = (confirmed ? batch.confirmedByType : batch.createdByType) ?? 'user';
  if (type === 'api_key') {
    const [key] = id
      ? await db
          .select({ name: apiKey.name, prefix: apiKey.prefix })
          .from(apiKey)
          .where(eq(apiKey.id, id))
      : [];
    return { type, id, label: key ? `${key.name} (${key.prefix})` : '' };
  }
  const [row] = id ? await db.select({ email: user.email }).from(user).where(eq(user.id, id)) : [];
  return { type: 'user', id, label: row?.email ?? '' };
}

/**
 * Issues a confirmed batch's pending rows, one transaction per row (design plan §8.3). A row is
 * locked, awarded and marked `issued` together, so it is issued at most once even if a job runs
 * twice; the database also allows only one credential per batch row. A row that can't be
 * awarded is marked `failed` with the reason; when no later row could succeed either (the org was
 * suspended, the achievement archived, the email cap reached), the batch stops.
 *
 * Returns `more` when time ran out with rows still pending.
 */
export async function issueBatch(
  services: AwardServices,
  batchId: string,
  options: IssueChunkOptions = {},
  log?: { error(object: unknown, message: string): void },
): Promise<'done' | 'more'> {
  const { db } = services;
  const budget = options.budgetMs ?? 30_000;
  const started = Date.now();
  const [batch] = await db.select().from(issuanceBatch).where(eq(issuanceBatch.id, batchId));
  if (!batch || (batch.status !== 'queued' && batch.status !== 'running')) return 'done';
  if (batch.status === 'queued') {
    await db
      .update(issuanceBatch)
      .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(issuanceBatch.id, batchId), eq(issuanceBatch.status, 'queued')));
  }
  const actor = await batchActor(db, batch);
  let stop: { code: string; message: string } | null = null;
  let after = 0;

  while (!stop && Date.now() - started < budget) {
    const next = await db
      .select({ rowNumber: issuanceBatchRow.rowNumber })
      .from(issuanceBatchRow)
      .where(
        and(
          eq(issuanceBatchRow.batchId, batchId),
          eq(issuanceBatchRow.status, 'pending'),
          gt(issuanceBatchRow.rowNumber, after),
        ),
      )
      .orderBy(asc(issuanceBatchRow.rowNumber))
      .limit(25);
    if (next.length === 0) break;
    for (const { rowNumber } of next) {
      after = rowNumber;
      if (stop || Date.now() - started >= budget) break;
      stop = await issueRow(services, batch, rowNumber, actor, log);
    }
    await db
      .update(issuanceBatch)
      .set({ updatedAt: new Date() })
      .where(eq(issuanceBatch.id, batchId));
  }

  if (stop) {
    await db
      .update(issuanceBatchRow)
      .set({
        status: 'failed',
        errorCode: stop.code,
        errorMessage: stop.message,
        processedAt: new Date(),
      })
      .where(and(eq(issuanceBatchRow.batchId, batchId), eq(issuanceBatchRow.status, 'pending')));
    await db
      .update(issuanceBatch)
      .set({ status: 'failed', error: stop.message, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(issuanceBatch.id, batchId));
    return 'done';
  }
  const [left] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issuanceBatchRow)
    .where(and(eq(issuanceBatchRow.batchId, batchId), eq(issuanceBatchRow.status, 'pending')));
  if ((left?.count ?? 0) > 0) return 'more';
  await db
    .update(issuanceBatch)
    .set({ status: 'completed', finishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(issuanceBatch.id, batchId), inArray(issuanceBatch.status, ['queued', 'running'])),
    );
  return 'done';
}

/** Issues one row. Returns the failure when the whole batch should stop. */
async function issueRow(
  services: AwardServices,
  batch: BatchRecord,
  rowNumber: number,
  actor: AwardActor,
  log?: { error(object: unknown, message: string): void },
): Promise<{ code: string; message: string } | null> {
  return services.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(issuanceBatchRow)
      .where(
        and(
          eq(issuanceBatchRow.batchId, batch.id),
          eq(issuanceBatchRow.rowNumber, rowNumber),
          eq(issuanceBatchRow.status, 'pending'),
        ),
      )
      .for('update', { skipLocked: true });
    if (!row?.values) return null;
    const values: BatchRowValues = row.values;
    const now = new Date();

    // Someone may have awarded them since the batch was confirmed.
    if (row.validation === 'ready' && !batch.options.awardExisting) {
      const [held] = await tx
        .select({ id: credential.id })
        .from(credential)
        .where(
          and(
            eq(credential.orgId, batch.orgId),
            eq(credential.achievementId, batch.achievementId),
            eq(credential.recipientEmail, values.email),
            eq(credential.status, 'issued'),
          ),
        )
        .limit(1);
      if (held) {
        await tx
          .update(issuanceBatchRow)
          .set({
            status: 'skipped',
            errorCode: 'existing',
            errorMessage: 'Already holds this achievement',
            processedAt: now,
          })
          .where(
            and(eq(issuanceBatchRow.batchId, batch.id), eq(issuanceBatchRow.rowNumber, rowNumber)),
          );
        return null;
      }
    }

    const award: ParsedAward = {
      achievementId: batch.achievementId,
      recipient: { name: values.name, email: values.email },
      issuedOn: values.issuedOn,
      expiresOn: values.expiresOn,
      evidence: values.evidenceUrl ? [{ url: values.evidenceUrl }] : undefined,
      sendEmail: batch.options.sendEmail,
    };
    try {
      // A savepoint: a refused award rolls back alone, and the row records why.
      const id = await tx.transaction((savepoint) =>
        awardInTransaction(
          savepoint,
          services,
          { orgId: batch.orgId },
          award,
          actor,
          {},
          {
            batch: { id: batch.id, rowNumber },
            customFields: values.custom,
          },
        ),
      );
      await tx
        .update(issuanceBatchRow)
        .set({
          status: 'issued',
          credentialId: id,
          errorCode: null,
          errorMessage: null,
          processedAt: now,
        })
        .where(
          and(eq(issuanceBatchRow.batchId, batch.id), eq(issuanceBatchRow.rowNumber, rowNumber)),
        );
      return null;
    } catch (error) {
      if (isTransient(error)) throw error;
      const failure = failureOf(error) ?? {
        code: 'internal_error',
        message: 'Something went wrong while signing this badge.',
      };
      if (failure.code === 'internal_error')
        log?.error({ err: error, batchId: batch.id, rowNumber }, 'batch row failed');
      await tx
        .update(issuanceBatchRow)
        .set({
          status: 'failed',
          errorCode: failure.code,
          errorMessage: failure.message,
          processedAt: now,
        })
        .where(
          and(eq(issuanceBatchRow.batchId, batch.id), eq(issuanceBatchRow.rowNumber, rowNumber)),
        );
      return STOPPING_CODES.has(failure.code) ? failure : null;
    }
  });
}

/** Batches that should be running but haven't moved for a while (their job was lost). */
export async function batchesToResume(db: Queryable, idleSeconds = 120): Promise<string[]> {
  const rows = await db
    .select({ id: issuanceBatch.id })
    .from(issuanceBatch)
    .where(
      and(
        inArray(issuanceBatch.status, ['queued', 'running']),
        lt(issuanceBatch.updatedAt, sql`now() - make_interval(secs => ${idleSeconds})`),
      ),
    );
  return rows.map((row) => row.id);
}

/** Deletes uploaded CSV files older than `days` (design plan §13.5). The batches stay. */
export async function deleteOldImports(db: Database, storage: Storage, days = 30): Promise<number> {
  const old = await db
    .select()
    .from(file)
    .where(
      and(
        eq(file.kind, 'csv_import'),
        lt(file.createdAt, sql`now() - make_interval(days => ${days})`),
      ),
    )
    .limit(500);
  for (const row of old) {
    await db.delete(file).where(eq(file.id, row.id));
    await storage.delete(row.key);
  }
  return old.length;
}

// ---- reading ----

export function emptyCounts(): BatchCounts {
  return {
    ready: 0,
    invalid: 0,
    duplicate: 0,
    existing: 0,
    pending: 0,
    issued: 0,
    failed: 0,
    skipped: 0,
  };
}

/** Row counts per batch: by check result and by issuing status. A header line isn't counted. */
export async function countRows(
  db: Queryable,
  batchIds: string[],
): Promise<Map<string, BatchCounts>> {
  const map = new Map<string, BatchCounts>(batchIds.map((id) => [id, emptyCounts()]));
  if (batchIds.length === 0) return map;
  const rows = await db
    .select({
      batchId: issuanceBatchRow.batchId,
      validation: issuanceBatchRow.validation,
      status: issuanceBatchRow.status,
      count: sql<number>`count(*)::int`,
    })
    .from(issuanceBatchRow)
    .innerJoin(issuanceBatch, eq(issuanceBatchRow.batchId, issuanceBatch.id))
    .where(
      and(
        inArray(issuanceBatchRow.batchId, batchIds),
        sql`not (${issuanceBatch.source} = 'csv' and ${issuanceBatch.hasHeader} and ${issuanceBatchRow.rowNumber} = 1)`,
      ),
    )
    .groupBy(issuanceBatchRow.batchId, issuanceBatchRow.validation, issuanceBatchRow.status);
  for (const row of rows) {
    const counts = map.get(row.batchId);
    if (!counts) continue;
    counts[row.validation] += row.count;
    if (row.status !== 'draft') counts[row.status] += row.count;
  }
  return map;
}

async function creatorLabels(db: Queryable, batches: BatchRecord[]): Promise<Map<string, string>> {
  const idsOf = (type: 'user' | 'api_key') => [
    ...new Set(
      batches
        .filter((batch) => batch.createdByType === type)
        .map((batch) => batch.createdById)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const userIds = idsOf('user');
  const keyIds = idsOf('api_key');
  const users = userIds.length
    ? await db
        .select({ id: user.id, label: user.email })
        .from(user)
        .where(inArray(user.id, userIds))
    : [];
  const keys = keyIds.length
    ? await db
        .select({ id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix })
        .from(apiKey)
        .where(inArray(apiKey.id, keyIds))
    : [];
  return new Map([
    ...users.map((row) => [row.id, row.label] as const),
    ...keys.map((row) => [row.id, `${row.name} (${row.prefix})`] as const),
  ]);
}

export async function serializeBatches(
  db: Queryable,
  batches: BatchRecord[],
): Promise<BatchSummary[]> {
  const counts = await countRows(
    db,
    batches.map((batch) => batch.id),
  );
  const labels = await creatorLabels(db, batches);
  const achievementIds = [...new Set(batches.map((batch) => batch.achievementId))];
  const names = new Map(
    achievementIds.length === 0
      ? []
      : (
          await db
            .select({ id: achievement.id, name: achievement.name })
            .from(achievement)
            .where(inArray(achievement.id, achievementIds))
        ).map((row) => [row.id, row.name]),
  );
  return batches.map((batch) => ({
    id: batch.id,
    achievement: { id: batch.achievementId, name: names.get(batch.achievementId) ?? '' },
    source: batch.source,
    fileName: batch.fileName,
    status: batch.status,
    totalRows: batch.totalRows,
    counts: counts.get(batch.id) ?? emptyCounts(),
    options: batch.options,
    createdBy: {
      type: batch.createdByType,
      id: batch.createdById,
      label: batch.createdById ? (labels.get(batch.createdById) ?? null) : null,
    },
    error: batch.error,
    createdAt: batch.createdAt.toISOString(),
    confirmedAt: batch.confirmedAt?.toISOString() ?? null,
    startedAt: batch.startedAt?.toISOString() ?? null,
    finishedAt: batch.finishedAt?.toISOString() ?? null,
  }));
}

export async function loadBatchDetails(
  db: Queryable,
  config: { defaultOrgDailySendLimit: number },
  orgId: string,
  batchId: string,
): Promise<BatchDetails> {
  const [batch] = await db
    .select()
    .from(issuanceBatch)
    .where(and(eq(issuanceBatch.orgId, orgId), eq(issuanceBatch.id, batchId)));
  if (!batch) throw notFound('Batch');
  const [summary] = await serializeBatches(db, [batch]);
  if (!summary) throw notFound('Batch');
  const samples = await db
    .select({ cells: issuanceBatchRow.cells })
    .from(issuanceBatchRow)
    .where(
      and(
        eq(issuanceBatchRow.batchId, batchId),
        gte(issuanceBatchRow.rowNumber, firstDataRow(batch)),
        isNull(issuanceBatchRow.erasedAt),
      ),
    )
    .orderBy(asc(issuanceBatchRow.rowNumber))
    .limit(3);
  const [org] = await db
    .select({ id: organization.id, dailySendLimit: organization.dailySendLimit })
    .from(organization)
    .where(eq(organization.id, orgId));
  const counts = summary.counts;
  const toAward =
    batch.status === 'draft'
      ? counts.ready + (batch.options.awardExisting ? counts.existing : 0)
      : counts.pending + counts.issued + counts.failed;
  return {
    ...summary,
    hasHeader: batch.hasHeader,
    columns: batch.columns.map((column, index) => ({
      header: column.header,
      target: column.target,
      samples: samples.map((row) => row.cells[index] ?? ''),
    })),
    plan: {
      toAward,
      toSkip: summary.totalRows - toAward,
      emails: batch.options.sendEmail ? toAward : 0,
      sendLimit: org
        ? await remainingSends(db, org, config.defaultOrgDailySendLimit)
        : { limit: null, remaining: null },
    },
  };
}

export function serializeBatchRow(publicBaseUrl: string, row: BatchRowRecord): BatchRow {
  return {
    rowNumber: row.rowNumber,
    values: row.values
      ? {
          name: row.values.name,
          email: row.values.email,
          ...(row.values.issuedOn && { issuedOn: row.values.issuedOn }),
          ...(row.values.expiresOn && { expiresOn: row.values.expiresOn }),
          ...(row.values.evidenceUrl && { evidenceUrl: row.values.evidenceUrl }),
          custom: row.values.custom,
        }
      : null,
    validation: row.validation,
    issues: row.issues,
    status: row.status,
    credential: row.credentialId
      ? { id: row.credentialId, url: credentialUrl(publicBaseUrl, row.credentialId) }
      : null,
    error: row.errorCode ? { code: row.errorCode, message: row.errorMessage ?? '' } : null,
    erasedAt: row.erasedAt?.toISOString() ?? null,
  };
}

/** Data rows of a batch, in order; a header line is never one. */
export function dataRowsCondition(batch: Pick<BatchRecord, 'id' | 'hasHeader' | 'source'>) {
  return and(
    eq(issuanceBatchRow.batchId, batch.id),
    gte(issuanceBatchRow.rowNumber, firstDataRow(batch)),
  );
}

export async function loadBatch(
  db: Queryable,
  orgId: string,
  batchId: string,
): Promise<BatchRecord> {
  const [batch] = await db
    .select()
    .from(issuanceBatch)
    .where(and(eq(issuanceBatch.orgId, orgId), eq(issuanceBatch.id, batchId)));
  if (!batch) throw notFound('Batch');
  return batch;
}

const STATUS_WORDS: Record<string, string> = {
  draft: 'not confirmed',
  pending: 'waiting',
  issued: 'awarded',
  failed: 'failed',
  skipped: 'skipped',
};

/**
 * The results file (design plan §8.3): one line per row of the upload, with the credential's
 * URL or why it wasn't awarded. Written a page of rows at a time.
 */
export async function* resultsCsv(
  db: Queryable,
  publicBaseUrl: string,
  batch: BatchRecord,
): AsyncGenerator<string> {
  const customKeys = batch.columns
    .map((column, index) =>
      column.target === 'custom'
        ? column.header.trim().slice(0, 100) || `Column ${index + 1}`
        : null,
    )
    .filter((key): key is string => key !== null);
  yield CSV_BOM +
    csvLine(['Row', 'Name', 'Email', 'Result', 'Credential URL', 'Problem', ...customKeys]);
  let after = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(issuanceBatchRow)
      .where(and(dataRowsCondition(batch), gt(issuanceBatchRow.rowNumber, after)))
      .orderBy(asc(issuanceBatchRow.rowNumber))
      .limit(1000);
    if (rows.length === 0) return;
    let chunk = '';
    for (const row of rows) {
      after = row.rowNumber;
      const problem =
        row.errorMessage ??
        (row.status === 'draft' ? row.issues.map((issue) => issue.message).join('; ') : '');
      chunk += csvLine([
        row.rowNumber,
        row.values?.name ?? '',
        row.values?.email ?? '',
        row.erasedAt ? 'erased' : (STATUS_WORDS[row.status] ?? row.status),
        row.credentialId ? credentialUrl(publicBaseUrl, row.credentialId) : '',
        problem,
        ...customKeys.map((key) => row.values?.custom[key] ?? ''),
      ]);
    }
    yield chunk;
  }
}
