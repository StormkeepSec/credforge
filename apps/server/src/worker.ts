import { createDatabase } from '@credforge/db';
import { pino } from 'pino';
import { loadConfigOrExit } from './config';
import { createKeyEncryption } from './crypto/key-encryption';
import { loadDevEnvFile } from './dev-env';
import { createQueueOutbox } from './email/outbox';
import { createDeliveryTracker } from './email/tracking';
import { createEmailTransport } from './email/transport';
import { createStorage } from './files/storage';
import { enforceMasterKey, enforcePublicBaseUrl } from './instance';
import { createDomainChecker } from './issuers/domain';
import { registerJobs } from './jobs';
import { createJobQueue } from './jobs/enqueue';
import { loggerOptions } from './logger';
import { createQueueClient } from './queue';
import { onShutdown } from './shutdown';

loadDevEnvFile();
const config = loadConfigOrExit();
const log = pino({ ...loggerOptions(config), name: 'worker' });
const { db, pool } = createDatabase(config.databaseUrl, {
  applicationName: 'credforge-worker',
  max: 4,
});

const boss = createQueueClient(config.databaseUrl, {
  applicationName: 'credforge-worker-queue',
  worker: true,
});
boss.on('error', (err) => log.error({ err }, 'job queue error'));

const keys = createKeyEncryption(config.masterKey);

try {
  await enforcePublicBaseUrl(db, config, log);
  await enforceMasterKey(db, keys, log);
  await boss.start();
  await registerJobs(boss, log, {
    emailTransport: createEmailTransport(config, log),
    deliveryTracker: createDeliveryTracker(db),
    issuing: {
      db,
      config,
      keys,
      outbox: createQueueOutbox(boss),
      storage: createStorage(config.storage),
      jobs: createJobQueue(boss),
      domains: createDomainChecker(`credforge-domain-check (+${config.publicBaseUrl})`),
    },
  });
} catch (err) {
  log.fatal({ err }, 'worker failed to start');
  await pool.end();
  process.exit(1);
}

onShutdown(log, async () => {
  await boss.stop({ graceful: true, timeout: 30_000 });
  await pool.end();
});

log.info({ emailTransport: config.email.transport }, 'credforge worker ready');
