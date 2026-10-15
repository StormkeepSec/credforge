import { PgBoss } from 'pg-boss';

/**
 * A pg-boss client for the app or worker. It never changes the queue schema (`migrate: false`):
 * the `migrate` service installs and upgrades it as the database owner, and the app's restricted
 * role only reads and writes jobs.
 */
export function createQueueClient(
  connectionString: string,
  options: { applicationName: string; worker: boolean },
): PgBoss {
  return new PgBoss({
    connectionString,
    application_name: options.applicationName,
    migrate: false,
    supervise: options.worker,
    schedule: options.worker,
    ...(options.worker ? { instanceName: 'worker' } : { registerInstance: false }),
  });
}
