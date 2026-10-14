import { createDatabase } from '@credforge/db';
import { PgBoss } from 'pg-boss';
import { pino } from 'pino';
import { loadConfigOrExit } from './config';
import { loadDevEnvFile } from './dev-env';
import { enforcePublicBaseUrl } from './instance';
import { registerJobs } from './jobs';
import { loggerOptions } from './logger';
import { onShutdown } from './shutdown';

loadDevEnvFile();
const config = loadConfigOrExit();
const log = pino({ ...loggerOptions(config), name: 'worker' });
const { db, pool } = createDatabase(config.databaseUrl, {
  applicationName: 'credforge-worker',
  max: 4,
});

const boss = new PgBoss({
  connectionString: config.databaseUrl,
  application_name: 'credforge-worker-queue',
  instanceName: 'worker',
});
boss.on('error', (err) => log.error({ err }, 'job queue error'));

try {
  await enforcePublicBaseUrl(db, config, log);
  await boss.start();
  await registerJobs(boss, log);
} catch (err) {
  log.fatal({ err }, 'worker failed to start');
  await pool.end();
  process.exit(1);
}

onShutdown(log, async () => {
  await boss.stop({ graceful: true, timeout: 30_000 });
  await pool.end();
});

log.info('credforge worker ready');
