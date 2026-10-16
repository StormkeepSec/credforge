import { randomUUID } from 'node:crypto';
import type { RecipientErasurePreview, RecipientErasureResult } from '@credforge/contracts';
import {
  achievement,
  and,
  asc,
  credential,
  emailMessage,
  eq,
  file,
  inArray,
  isNull,
  issuanceBatch,
  issuanceBatchRow,
  or,
  organization,
  type Queryable,
  sql,
} from '@credforge/db';
import { ApiError, notFound } from '../api/errors';
import { type AuditActor, recordAudit } from '../audit/audit';
import type { Storage } from '../files/storage';
import { deleteEmailJobs } from '../jobs/enqueue';
import { forgetVerification } from '../verify/local';
import { type RevocationServices, revokeRows } from './revocation';
import { type CredentialRow, credentialState, type RequestInfo } from './service';

/**
 * Erasing a recipient's data (design plan §12.1, decision 50).
 *
 * An erasure starts from one badge and covers every badge the org awarded to the same address,
 * plus badges linked to those by a reissue, and every CSV batch row holding the address. In one
 * transaction it revokes the badges still valid (their status-list bits stay set for good), turns
 * the credentials into tombstones, empties the email records and batch rows, deletes queued email
 * jobs and the uploaded CSV files, and deletes the credentials' audit keys, which leaves what the
 * append-only audit log says about the person unreadable. A ledger entry without personal data is
 * written to storage, so a restore from an older backup can erase them again.
 */

export interface ErasureServices extends Pick<RevocationServices, 'db' | 'jobs'> {
  storage: Storage;
}

/** The internal reason recorded on badges an erasure revokes. */
const ERASED_REASON = 'The recipient’s data was erased.';
/** What an erased batch row says instead of its problems. */
const ERASED_ROW_MESSAGE = 'This person’s data was erased.';

/** Where ledger entries go in the files bucket (one object per erasure, no personal data). */
export const LEDGER_PREFIX = 'erasures/';

interface LedgerEntry {
  erasureId: string;
  orgId: string;
  at: string;
  credentialIds: string[];
  batchRows: { batchId: string; rowNumber: number }[];
}

interface BatchRowRef {
  batchId: string;
  rowNumber: number;
}

interface Scope {
  /** The address the erasure started from (null when that badge was erased already). */
  recipient: { name: string; email: string } | null;
  credentials: CredentialRow[];
  batchRows: BatchRowRef[];
}

/** Where to start: a badge (the issuer app and API), or an address (the operator's CLI). */
export type ErasureStart = { credentialId: string } | { email: string };

/** Every credential linked to these by reissues (`replaces_id` / `replaced_by_id`), transitively. */
async function withReissueChains(
  db: Queryable,
  orgId: string,
  rows: CredentialRow[],
): Promise<CredentialRow[]> {
  const found = new Map(rows.map((row) => [row.id, row]));
  let frontier = rows;
  while (frontier.length > 0) {
    const linked = frontier.flatMap((row) =>
      [row.replacesId, row.replacedById].filter((id): id is string => id !== null),
    );
    const ids = frontier.map((row) => row.id);
    const next = await db
      .select()
      .from(credential)
      .where(
        and(
          eq(credential.orgId, orgId),
          or(
            linked.length > 0 ? inArray(credential.id, linked) : undefined,
            inArray(credential.replacesId, ids),
            inArray(credential.replacedById, ids),
          ),
        ),
      );
    frontier = next.filter((row) => !found.has(row.id));
    for (const row of frontier) found.set(row.id, row);
  }
  return [...found.values()];
}

/** The rows an erasure covers. With `lock`, the credentials are locked (in id order). */
async function erasureScope(
  db: Queryable,
  orgId: string,
  start: ErasureStart,
  lock: boolean,
): Promise<Scope> {
  let email: string | null;
  let seed: CredentialRow[];
  let recipient: Scope['recipient'] = null;
  if ('credentialId' in start) {
    const [anchor] = await db
      .select()
      .from(credential)
      .where(and(eq(credential.orgId, orgId), eq(credential.id, start.credentialId)));
    if (!anchor) throw notFound('Credential');
    email = anchor.recipientEmail;
    if (anchor.recipientName !== null && anchor.recipientEmail !== null) {
      recipient = { name: anchor.recipientName, email: anchor.recipientEmail };
    }
    seed = [anchor];
  } else {
    email = start.email;
    seed = [];
  }
  if (email) {
    const same = await db
      .select()
      .from(credential)
      .where(and(eq(credential.orgId, orgId), eq(credential.recipientEmail, email)));
    seed = [...seed, ...same.filter((row) => !seed.some((known) => known.id === row.id))];
    if (!recipient && same[0]?.recipientName) recipient = { name: same[0].recipientName, email };
  }
  const chained = await withReissueChains(db, orgId, seed);
  const ids = chained.map((row) => row.id).sort();
  const credentials =
    lock && ids.length > 0
      ? await db
          .select()
          .from(credential)
          .where(and(eq(credential.orgId, orgId), inArray(credential.id, ids)))
          .orderBy(asc(credential.id))
          .for('update')
      : chained.sort((a, b) => a.id.localeCompare(b.id));

  // Batch rows that awarded one of the badges, or hold the address as mapped or in any raw cell.
  const holdsAddress = email
    ? sql`(${issuanceBatchRow.values}->>'email' = ${email} or exists (
        select 1 from jsonb_array_elements_text(${issuanceBatchRow.cells}) as cell
        where lower(btrim(cell)) = ${email}))`
    : undefined;
  const batchRows =
    ids.length > 0 || holdsAddress
      ? await db
          .select({ batchId: issuanceBatchRow.batchId, rowNumber: issuanceBatchRow.rowNumber })
          .from(issuanceBatchRow)
          .where(
            and(
              inArray(
                issuanceBatchRow.batchId,
                db
                  .select({ id: issuanceBatch.id })
                  .from(issuanceBatch)
                  .where(eq(issuanceBatch.orgId, orgId)),
              ),
              isNull(issuanceBatchRow.erasedAt),
              or(
                ids.length > 0 ? inArray(issuanceBatchRow.credentialId, ids) : undefined,
                holdsAddress,
              ),
            ),
          )
          .orderBy(asc(issuanceBatchRow.batchId), asc(issuanceBatchRow.rowNumber))
      : [];
  return { recipient, credentials, batchRows };
}

/** What erasing from this badge would cover, for the issuer app to show before confirming. */
export async function previewErasure(
  db: Queryable,
  orgId: string,
  credentialId: string,
): Promise<RecipientErasurePreview> {
  const scope = await erasureScope(db, orgId, { credentialId }, false);
  const names = new Map(
    (scope.credentials.length > 0
      ? await db
          .select({ id: achievement.id, name: achievement.name })
          .from(achievement)
          .where(
            inArray(
              achievement.id,
              scope.credentials.map((row) => row.achievementId),
            ),
          )
      : []
    ).map((row) => [row.id, row.name]),
  );
  const now = new Date();
  return {
    recipient: scope.recipient,
    credentials: scope.credentials
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({
        id: row.id,
        achievement: { id: row.achievementId, name: names.get(row.achievementId) ?? '' },
        state: credentialState(row, now),
        validFrom: row.validFrom.toISOString(),
        erased: row.erasedAt !== null,
      })),
    toRevoke: scope.credentials.filter((row) => row.status === 'issued').length,
    batchRows: scope.batchRows.length,
  };
}

const alreadyErased = () =>
  new ApiError(
    409,
    'already_erased',
    'Already erased',
    'This person’s data was already erased from these badges.',
  );

/**
 * Erases the scope's credentials and batch rows in the caller's transaction (the org row locked
 * first, as for awards, and the credentials locked). Returns the storage keys of CSV uploads to
 * delete once the transaction has committed.
 */
async function eraseInTransaction(
  tx: Queryable,
  services: ErasureServices,
  orgId: string,
  scope: Pick<Scope, 'credentials' | 'batchRows'>,
  erasureId: string,
  actor: AuditActor,
  request: RequestInfo,
): Promise<{ erased: string[]; revoked: string[]; batchRows: number; files: string[] }> {
  const now = new Date();
  const rows = scope.credentials.filter((row) => row.erasedAt === null);
  const ids = rows.map((row) => row.id);
  const issued = rows.filter((row) => row.status === 'issued');

  // 1. Revoke what is still valid: the bits stay set, so every copy verifies as revoked.
  await revokeRows(tx, services, orgId, issued, { reason: ERASED_REASON }, null, request);

  if (ids.length > 0) {
    // 2. Tombstones. The status-list entry, dates, achievement and issuer stay.
    await tx
      .update(credential)
      .set({
        document: null,
        recipientEmail: null,
        recipientName: null,
        emailSalt: null,
        evidence: [],
        customFields: {},
        claimTokenHash: null,
        claimTokenExpiresAt: null,
        acceptedAt: null,
        revocationReason: null,
        revocationPublicReason: null,
        auditKey: null,
        erasedAt: now,
        updatedAt: now,
      })
      .where(and(eq(credential.orgId, orgId), inArray(credential.id, ids)));

    // 3. Emails: no address, provider reasons or errors; statuses and times stay (the send cap
    // counts them). Jobs still waiting to send them hold the address, so they go too.
    const messages = await tx
      .update(emailMessage)
      .set({
        toEmail: null,
        lastError: null,
        providerMessageId: null,
        events: sql`coalesce((select jsonb_agg(event - 'reason') from jsonb_array_elements(${emailMessage.events}) as event), '[]'::jsonb)`,
        updatedAt: now,
      })
      .where(and(eq(emailMessage.orgId, orgId), inArray(emailMessage.credentialId, ids)))
      .returning({ id: emailMessage.id });
    await deleteEmailJobs(
      tx,
      messages.map((message) => message.id),
    );
  }

  // 4. Batch rows: emptied and marked, never checked or awarded again.
  const batchIds = [...new Set(scope.batchRows.map((row) => row.batchId))];
  let erasedRows = 0;
  for (const batchId of batchIds) {
    const numbers = scope.batchRows
      .filter((row) => row.batchId === batchId)
      .map((row) => row.rowNumber);
    const changed = await tx
      .update(issuanceBatchRow)
      .set({
        cells: [],
        values: null,
        validation: 'invalid',
        issues: [{ field: 'row', message: ERASED_ROW_MESSAGE }],
        status: sql`case when ${issuanceBatchRow.status} in ('draft', 'pending') then 'skipped' else ${issuanceBatchRow.status} end`,
        errorCode: sql`case when ${issuanceBatchRow.status} in ('draft', 'pending') then 'erased' else ${issuanceBatchRow.errorCode} end`,
        errorMessage: sql`case when ${issuanceBatchRow.status} in ('draft', 'pending') then ${ERASED_ROW_MESSAGE} else ${issuanceBatchRow.errorMessage} end`,
        erasedAt: now,
      })
      .where(
        and(
          eq(issuanceBatchRow.orgId, orgId),
          eq(issuanceBatchRow.batchId, batchId),
          inArray(issuanceBatchRow.rowNumber, numbers),
          isNull(issuanceBatchRow.erasedAt),
        ),
      )
      .returning({ rowNumber: issuanceBatchRow.rowNumber });
    erasedRows += changed.length;
  }
  // The uploaded files hold every row: deleted now rather than after 30 days.
  const uploads =
    batchIds.length > 0
      ? await tx
          .select({ id: file.id, key: file.key })
          .from(file)
          .where(
            inArray(
              file.id,
              tx
                .select({ id: issuanceBatch.fileId })
                .from(issuanceBatch)
                .where(and(eq(issuanceBatch.orgId, orgId), inArray(issuanceBatch.id, batchIds))),
            ),
          )
      : [];
  if (uploads.length > 0) {
    await tx.delete(file).where(
      inArray(
        file.id,
        uploads.map((upload) => upload.id),
      ),
    );
  }

  // 5. The audit log: what it says about the person is sealed with the keys deleted above.
  for (const row of rows) {
    await recordAudit(tx, {
      orgId,
      actor,
      action: 'credential.erased',
      target: { type: 'credential', id: row.id },
      data: { erasure: erasureId, revoked: row.status === 'issued' },
      request,
    });
  }
  for (const batchId of batchIds) {
    await recordAudit(tx, {
      orgId,
      actor,
      action: 'batch.rows_erased',
      target: { type: 'batch', id: batchId },
      data: {
        erasure: erasureId,
        rows: scope.batchRows.filter((row) => row.batchId === batchId).length,
        fileDeleted: uploads.length > 0,
      },
      request,
    });
  }
  return {
    erased: ids,
    revoked: issued.map((row) => row.id),
    batchRows: erasedRows,
    files: uploads.map((upload) => upload.key),
  };
}

/** Retries a transaction that lost a deadlock or serialization race (it changed nothing). */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (attempt >= 3 || (code !== '40P01' && code !== '40001')) throw error;
    }
  }
}

/**
 * Erases a recipient's data (design plan §12.1): every badge the org awarded to the address the
 * erasure starts from, the badges linked to those by reissues, and the batch rows holding it.
 * Refuses with 409 `already_erased` when nothing is left to erase. Suspended orgs may erase too:
 * it only removes data and revokes.
 */
export async function eraseRecipient(
  services: ErasureServices,
  orgId: string,
  start: ErasureStart,
  actor: AuditActor,
  request: RequestInfo,
): Promise<RecipientErasureResult> {
  const erasureId = randomUUID();
  const result = await withRetry(() =>
    services.db.transaction(async (tx) => {
      // The org first, as awards and batches do: no award to this person can start meanwhile.
      const [org] = await tx
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, orgId))
        .for('update');
      if (!org) throw notFound('Organization');
      const scope = await erasureScope(tx, orgId, start, true);
      if (scope.credentials.every((row) => row.erasedAt !== null) && scope.batchRows.length === 0) {
        if (scope.credentials.length === 0 && !('credentialId' in start))
          throw notFound('Recipient');
        throw alreadyErased();
      }
      const done = await eraseInTransaction(tx, services, orgId, scope, erasureId, actor, request);
      // Written before the commit: if storage fails, nothing is erased and the caller can retry.
      const entry: LedgerEntry = {
        erasureId,
        orgId,
        at: new Date().toISOString(),
        credentialIds: done.erased,
        batchRows: scope.batchRows,
      };
      await services.storage.put(
        `${LEDGER_PREFIX}${erasureId}.json`,
        Buffer.from(`${JSON.stringify(entry)}\n`),
        'application/json',
      );
      return done;
    }),
  );
  for (const id of result.erased) forgetVerification(id);
  for (const key of result.files) await services.storage.delete(key);
  return {
    erasureId,
    erased: result.erased,
    revoked: result.revoked,
    batchRows: result.batchRows,
  };
}

/**
 * Erases again what the ledger says was erased (`cli.js reapply-erasures`). Run after restoring
 * a backup: one taken before an erasure brings that person's data back. Credentials and batch
 * rows already erased, or not in the restored database, are left alone. Returns how many entries
 * changed something.
 */
export async function reapplyErasures(
  services: ErasureServices,
  actor: AuditActor,
): Promise<{ entries: number; reapplied: number }> {
  const keys = (await services.storage.list(LEDGER_PREFIX))
    .filter((key) => key.endsWith('.json'))
    .sort();
  let reapplied = 0;
  for (const key of keys) {
    const bytes = await services.storage.get(key);
    if (!bytes) continue;
    const entry = JSON.parse(bytes.toString('utf8')) as LedgerEntry;
    const changed = await withRetry(() =>
      services.db.transaction(async (tx) => {
        const [org] = await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, entry.orgId))
          .for('update');
        if (!org) return null;
        const credentials =
          entry.credentialIds.length > 0
            ? await tx
                .select()
                .from(credential)
                .where(
                  and(
                    eq(credential.orgId, entry.orgId),
                    inArray(credential.id, entry.credentialIds),
                    isNull(credential.erasedAt),
                  ),
                )
                .orderBy(asc(credential.id))
                .for('update')
            : [];
        const rows: BatchRowRef[] = [];
        for (const batchId of new Set(entry.batchRows.map((row) => row.batchId))) {
          const numbers = entry.batchRows
            .filter((row) => row.batchId === batchId)
            .map((row) => row.rowNumber);
          rows.push(
            ...(await tx
              .select({ batchId: issuanceBatchRow.batchId, rowNumber: issuanceBatchRow.rowNumber })
              .from(issuanceBatchRow)
              .where(
                and(
                  eq(issuanceBatchRow.orgId, entry.orgId),
                  eq(issuanceBatchRow.batchId, batchId),
                  inArray(issuanceBatchRow.rowNumber, numbers),
                  isNull(issuanceBatchRow.erasedAt),
                ),
              )),
          );
        }
        if (credentials.length === 0 && rows.length === 0) return null;
        return eraseInTransaction(
          tx,
          services,
          entry.orgId,
          { credentials, batchRows: rows },
          entry.erasureId,
          actor,
          {},
        );
      }),
    );
    if (!changed) continue;
    reapplied++;
    for (const id of changed.erased) forgetVerification(id);
    for (const file of changed.files) await services.storage.delete(file);
  }
  return { entries: keys.length, reapplied };
}
