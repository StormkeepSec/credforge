import type { Queryable } from '@credforge/db';
import type { PgBoss } from 'pg-boss';
import { transactionDatabase } from '../email/outbox';
import { QUEUES } from './queues';

/** Seconds a status list waits before it is re-signed, so a burst of revocations signs once. */
export const STATUS_LIST_DEBOUNCE_SECONDS = 5;

/**
 * Background work the app hands to the worker. With `tx`, the job is written in that
 * transaction, so it exists if and only if the change that needs it commits.
 *
 * The jobs are keyed by what they work on and their queues allow one waiting and one running
 * job per key (pg-boss `stately`), so asking again while a job waits adds nothing. The work is
 * recorded in the database first (`status_list.needs_publish`, a batch's `pending` rows, a
 * moderation item's `scan_status`), and the worker's sweep picks up anything whose job was lost.
 */
export interface JobQueue {
  /** Issues a confirmed batch's pending rows. */
  issueBatch(batchId: string, options?: { tx?: Queryable }): Promise<void>;
  /** Re-signs and publishes a status list a few seconds from now. */
  publishStatusList(statusListId: string, options?: { tx?: Queryable }): Promise<void>;
  /** Runs the automatic check of a moderation item (design plan §6.5, decision 60). */
  scanContent(itemId: string, options?: { tx?: Queryable }): Promise<void>;
}

export function createJobQueue(boss: Pick<PgBoss, 'send'>): JobQueue {
  const db = (tx?: Queryable) => (tx ? { db: transactionDatabase(tx) } : {});
  return {
    async issueBatch(batchId, options) {
      await boss.send(QUEUES.batch, { batchId }, { singletonKey: batchId, ...db(options?.tx) });
    },
    async publishStatusList(statusListId, options) {
      await boss.send(
        QUEUES.statusList,
        { statusListId },
        {
          singletonKey: statusListId,
          startAfter: STATUS_LIST_DEBOUNCE_SECONDS,
          ...db(options?.tx),
        },
      );
    },
    async scanContent(itemId, options) {
      await boss.send(QUEUES.scan, { itemId }, { singletonKey: itemId, ...db(options?.tx) });
    },
  };
}

/**
 * Deletes the email jobs of these `email_message` rows that aren't being sent right now: their
 * payloads hold the recipient's address and name (erasure, design plan §12.1). Jobs already sent
 * are deleted a day later anyway. Does nothing where the job queue isn't installed (some tests).
 */
export async function deleteEmailJobs(tx: Queryable, emailMessageIds: string[]): Promise<void> {
  if (emailMessageIds.length === 0) return;
  const queue = transactionDatabase(tx);
  const { rows } = await queue.executeSql(`select to_regclass('pgboss.job') is not null as ok`);
  if (!(rows[0] as { ok?: boolean } | undefined)?.ok) return;
  await queue.executeSql(
    `delete from pgboss.job where name = $1 and state <> 'active' and data->>'trackingId' = any($2::text[])`,
    [QUEUES.email, emailMessageIds],
  );
}

/** Records what was asked for. Used by tests, which run the jobs themselves. */
export function createMemoryJobQueue(): JobQueue & {
  batches: string[];
  statusLists: string[];
  scans: string[];
} {
  const batches: string[] = [];
  const statusLists: string[] = [];
  const scans: string[] = [];
  return {
    batches,
    statusLists,
    scans,
    async scanContent(itemId) {
      scans.push(itemId);
    },
    async issueBatch(batchId) {
      batches.push(batchId);
    },
    async publishStatusList(statusListId) {
      statusLists.push(statusListId);
    },
  };
}
