import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

/** Queue names. Keep them stable: jobs already enqueued refer to them by name. */
export const QUEUES = {
  /** Proves scheduling and job processing work end to end; later feeds worker health. */
  heartbeat: 'system.heartbeat',
} as const;

export async function registerJobs(boss: PgBoss, log: Logger): Promise<void> {
  await boss.createQueue(QUEUES.heartbeat);
  await boss.schedule(QUEUES.heartbeat, '*/5 * * * *');
  await boss.work(QUEUES.heartbeat, async ([job]) => {
    log.debug({ jobId: job?.id }, 'heartbeat');
  });
}
