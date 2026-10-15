import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { EMAIL_QUEUE_OPTIONS, EMAIL_WORK_OPTIONS, emailJobHandler } from '../email/outbox';
import type { EmailMessage, EmailTransport } from '../email/transport';
import { QUEUES } from './queues';

export { QUEUES } from './queues';

/**
 * Creates every queue. Runs in `migrate` (so the app can enqueue before the worker has ever
 * started) and again in the worker; both are idempotent.
 */
export async function createQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUES.heartbeat);
  await boss.createQueue(QUEUES.email, EMAIL_QUEUE_OPTIONS);
}

export interface JobDependencies {
  emailTransport: EmailTransport;
}

export async function registerJobs(
  boss: PgBoss,
  log: Logger,
  { emailTransport }: JobDependencies,
): Promise<void> {
  await createQueues(boss);
  await boss.schedule(QUEUES.heartbeat, '*/5 * * * *');
  await boss.work(QUEUES.heartbeat, async ([job]) => {
    log.debug({ jobId: job?.id }, 'heartbeat');
  });

  const sendEmail = emailJobHandler(emailTransport, log);
  await boss.work<EmailMessage>(QUEUES.email, EMAIL_WORK_OPTIONS, async (jobs) => {
    for (const job of jobs) await sendEmail(job.data);
  });
}
