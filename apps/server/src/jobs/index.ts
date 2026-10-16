import type { Database } from '@credforge/db';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { batchesToResume, deleteOldImports, issueBatch } from '../batches/service';
import type { Config } from '../config';
import type { KeyEncryption } from '../crypto/key-encryption';
import {
  EMAIL_QUEUE_OPTIONS,
  EMAIL_WORK_OPTIONS,
  type EmailOutbox,
  emailJobHandler,
} from '../email/outbox';
import type { DeliveryTracker } from '../email/tracking';
import type { EmailMessage, EmailTransport } from '../email/transport';
import type { Storage } from '../files/storage';
import { type DomainChecker, recheckVerifiedDomains } from '../issuers/domain';
import { listsWaitingToPublish, publishStatusList } from '../status-lists/service';
import type { JobQueue } from './enqueue';
import { QUEUES } from './queues';

export { QUEUES } from './queues';

/**
 * One waiting and one running job per key (a batch, a status list): asking again while one waits
 * adds nothing, and the same batch is never issued by two jobs at once.
 */
const KEYED_QUEUE_OPTIONS = {
  policy: 'stately',
  retryLimit: 10,
  retryDelay: 10,
  retryBackoff: true,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
} as const;

/**
 * Creates every queue. Runs in `migrate` (so the app can enqueue before the worker has ever
 * started) and again in the worker; both are idempotent.
 */
export async function createQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUES.heartbeat);
  await boss.createQueue(QUEUES.email, EMAIL_QUEUE_OPTIONS);
  await boss.createQueue(QUEUES.batch, KEYED_QUEUE_OPTIONS);
  await boss.createQueue(QUEUES.statusList, KEYED_QUEUE_OPTIONS);
  await boss.createQueue(QUEUES.sweep, { policy: 'stately' });
}

/** What the issuing jobs need: the same signing path as the app's awards. */
export interface IssuingDependencies {
  db: Database;
  config: Config;
  keys: KeyEncryption;
  outbox: EmailOutbox;
  storage: Storage;
  jobs: JobQueue;
  /** Re-checks verified issuer domains once a day (design plan §6.3). */
  domains?: DomainChecker;
}

export interface JobDependencies {
  emailTransport: EmailTransport;
  /** Updates award emails' delivery status (`email_message`). */
  deliveryTracker?: DeliveryTracker;
  /** Batches, status lists and the sweep. */
  issuing?: IssuingDependencies;
}

/** How long one batch job issues before it hands over to the next (and other batches). */
const BATCH_BUDGET_MS = 60_000;

export async function registerJobs(
  boss: PgBoss,
  log: Logger,
  { emailTransport, deliveryTracker, issuing }: JobDependencies,
): Promise<void> {
  await createQueues(boss);
  await boss.schedule(QUEUES.heartbeat, '*/5 * * * *');
  await boss.work(QUEUES.heartbeat, async ([job]) => {
    log.debug({ jobId: job?.id }, 'heartbeat');
  });

  const sendEmail = emailJobHandler(emailTransport, log, deliveryTracker);
  await boss.work<EmailMessage>(QUEUES.email, EMAIL_WORK_OPTIONS, async (jobs) => {
    for (const job of jobs) await sendEmail(job.data, job);
  });

  if (!issuing) return;
  const { db, storage, jobs } = issuing;

  await boss.work<{ batchId: string }>(
    QUEUES.batch,
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (!job) return;
      const result = await issueBatch(
        issuing,
        job.data.batchId,
        { budgetMs: BATCH_BUDGET_MS },
        log,
      );
      log.info({ batchId: job.data.batchId, result }, 'batch chunk issued');
      // Time ran out: carry on in a new job, so a 10,000-row batch never holds one job for long.
      if (result === 'more') await jobs.issueBatch(job.data.batchId);
    },
  );

  await boss.work<{ statusListId: string }>(
    QUEUES.statusList,
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (!job) return;
      const published = await publishStatusList(issuing, job.data.statusListId);
      if (published) log.info({ statusListId: job.data.statusListId }, 'status list published');
    },
  );

  await boss.schedule(QUEUES.sweep, '* * * * *');
  await boss.work(QUEUES.sweep, async () => {
    for (const id of await listsWaitingToPublish(db)) await jobs.publishStatusList(id);
    for (const id of await batchesToResume(db)) {
      log.warn({ batchId: id }, 'resuming a batch whose job went missing');
      await jobs.issueBatch(id);
    }
    const deleted = await deleteOldImports(db, storage);
    if (deleted > 0) log.info({ deleted }, 'deleted old CSV uploads');
    if (issuing.domains) {
      const domains = await recheckVerifiedDomains(db, issuing.domains, { limit: 5 });
      if (domains.checked > 0) log.info(domains, 're-checked verified issuer domains');
    }
  });
}
