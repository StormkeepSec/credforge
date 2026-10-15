import { createDatabase } from '@credforge/db';
import { pino } from 'pino';
import { buildApp } from './app';
import { createAuth } from './auth/auth';
import { loadConfigOrExit } from './config';
import { createKeyEncryption } from './crypto/key-encryption';
import { loadDevEnvFile } from './dev-env';
import { createQueueOutbox } from './email/outbox';
import { enforceMasterKey, enforcePublicBaseUrl } from './instance';
import { loggerOptions } from './logger';
import { createQueueClient } from './queue';
import { onShutdown } from './shutdown';

loadDevEnvFile();
const config = loadConfigOrExit();
const log = pino(loggerOptions(config));
const { db, pool } = createDatabase(config.databaseUrl, { applicationName: 'credforge-app' });
const boss = createQueueClient(config.databaseUrl, {
  applicationName: 'credforge-app-queue',
  worker: false,
});
boss.on('error', (err) => log.error({ err }, 'job queue error'));
const keys = createKeyEncryption(config.masterKey);
const outbox = createQueueOutbox(boss);
const auth = createAuth({ config, db, outbox, log });

const app = await buildApp({
  config,
  loggerInstance: log,
  checkDatabase: async () => {
    await pool.query('select 1');
  },
  services: { config, db, auth, outbox, keys },
});

try {
  await enforcePublicBaseUrl(db, config, log);
  await enforceMasterKey(db, keys, log);
  await boss.start();
} catch (err) {
  log.fatal({ err }, 'startup check failed');
  await pool.end();
  process.exit(1);
}

onShutdown(log, async () => {
  await app.close();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await pool.end();
});

await app.listen({ host: config.host, port: config.port });
log.info({ publicBaseUrl: config.publicBaseUrl }, 'credforge app ready');
