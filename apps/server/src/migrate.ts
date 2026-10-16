import { connectionUser, createDatabase, grantAppRole, migrateDatabase } from '@credforge/db';
import { PgBoss } from 'pg-boss';
import { pino } from 'pino';
import { sealEarlierAuditEvents } from './audit/seal-earlier-events';
import { loadConfigOrExit } from './config';
import { createKeyEncryption } from './crypto/key-encryption';
import { loadDevEnvFile } from './dev-env';
import { enforceMasterKey, enforcePublicBaseUrl } from './instance';
import { createQueues } from './jobs';
import { loggerOptions } from './logger';

// One-shot, as the database owner (MIGRATION_DATABASE_URL): applies database migrations (and,
// once, seals recipient details in audit events written before migration 0006), installs or
// upgrades the job queue schema, (re)grants the app's restricted role, and records
// PUBLIC_BASE_URL and the master key check. Runs before `app` and `worker` start (docker compose
// `migrate` service).
loadDevEnvFile();
const config = loadConfigOrExit();
const log = pino({ ...loggerOptions(config), name: 'migrate' });
const { db, pool } = createDatabase(config.migrationDatabaseUrl, {
  applicationName: 'credforge-migrate',
  max: 1,
});

try {
  await migrateDatabase(db, config.migrationsDir);
  log.info({ migrationsDir: config.migrationsDir }, 'database migrations applied');
  const sealed = await sealEarlierAuditEvents(pool);
  if (sealed !== null) {
    log.info({ events: sealed }, 'recipient details in earlier audit events sealed (once)');
  }

  const boss = new PgBoss({
    connectionString: config.migrationDatabaseUrl,
    application_name: 'credforge-migrate',
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  await boss.start();
  await createQueues(boss);
  await boss.stop({ graceful: false });
  log.info('job queue schema ready');

  const app = connectionUser(config.databaseUrl);
  const owner = connectionUser(config.migrationDatabaseUrl);
  if (app.user !== owner.user) {
    await grantAppRole(pool, { role: app.user, password: app.password, extraSchemas: ['pgboss'] });
    log.info({ role: app.user }, 'app database role ready (audit log: read and append only)');
  } else {
    log.warn(
      { role: app.user },
      'DATABASE_URL uses the database owner. The audit log is still append-only (triggers), but ' +
        'for least privilege set MIGRATION_DATABASE_URL to the owner and DATABASE_URL to a separate role.',
    );
  }

  await enforcePublicBaseUrl(db, config, log);
  await enforceMasterKey(db, createKeyEncryption(config.masterKey), log);
} catch (err) {
  log.fatal({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
