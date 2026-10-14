import { createDatabase } from '@credforge/db';
import { buildApp } from './app';
import { loadConfigOrExit } from './config';
import { loadDevEnvFile } from './dev-env';
import { enforcePublicBaseUrl } from './instance';
import { onShutdown } from './shutdown';

loadDevEnvFile();
const config = loadConfigOrExit();
const { db, pool } = createDatabase(config.databaseUrl, { applicationName: 'credforge-app' });

const app = await buildApp({
  config,
  checkDatabase: async () => {
    await pool.query('select 1');
  },
});

try {
  await enforcePublicBaseUrl(db, config, app.log);
} catch (err) {
  app.log.fatal({ err }, 'startup check failed');
  await pool.end();
  process.exit(1);
}

onShutdown(app.log, async () => {
  await app.close();
  await pool.end();
});

await app.listen({ host: config.host, port: config.port });
app.log.info({ publicBaseUrl: config.publicBaseUrl }, 'credforge app ready');
