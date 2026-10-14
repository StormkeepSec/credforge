import { createDatabase, migrateDatabase } from '@credforge/db';
import { PgBoss } from 'pg-boss';
import { pino } from 'pino';
import { loadConfigOrExit } from './config';
import { loadDevEnvFile } from './dev-env';
import { enforcePublicBaseUrl } from './instance';
import { loggerOptions } from './logger';

// One-shot: applies database migrations, installs/upgrades the job queue schema, and records
// PUBLIC_BASE_URL. Runs before `app` and `worker` start (docker compose `migrate` service).
loadDevEnvFile();
const config = loadConfigOrExit();
const log = pino({ ...loggerOptions(config), name: 'migrate' });
const { db, pool } = createDatabase(config.databaseUrl, {
  applicationName: 'credforge-migrate',
  max: 1,
});

try {
  await migrateDatabase(db, config.migrationsDir);
  log.info({ migrationsDir: config.migrationsDir }, 'database migrations applied');

  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    application_name: 'credforge-migrate',
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  await boss.start();
  await boss.stop({ graceful: false });
  log.info('job queue schema ready');

  await enforcePublicBaseUrl(db, config, log);
} catch (err) {
  log.fatal({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
