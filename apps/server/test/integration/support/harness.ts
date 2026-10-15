import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDatabase, grantAppRole, migrateDatabase } from '@credforge/db';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../../../src/app';
import { createAuth } from '../../../src/auth/auth';
import { loadConfig } from '../../../src/config';
import { createKeyEncryption } from '../../../src/crypto/key-encryption';
import { createMemoryOutbox } from '../../../src/email/outbox';
import { createLocalStorage } from '../../../src/files/storage';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../../../packages/db/migrations');
export const BASE_URL = 'https://credforge.test';

const silent = { error() {}, warn() {}, info() {} };

function withCredentials(
  url: string,
  changes: { user?: string; password?: string; database?: string },
) {
  const parsed = new URL(url);
  if (changes.user) parsed.username = encodeURIComponent(changes.user);
  if (changes.password) parsed.password = encodeURIComponent(changes.password);
  if (changes.database) parsed.pathname = `/${changes.database}`;
  return parsed.toString();
}

export type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

/**
 * A fresh database (migrated as the owner, used by the app through its restricted role, exactly
 * as in production) and an app built on it, with email captured in memory.
 */
export async function createTestEnvironment(env: Record<string, string> = {}) {
  const serverUrl = inject('databaseUrl');
  const suffix = randomBytes(6).toString('hex');
  const database = `credforge_test_${suffix}`;
  const appRole = `credforge_app_${suffix}`;
  const appPassword = randomBytes(12).toString('hex');

  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`create database ${database}`);
  await admin.end();

  const ownerUrl = withCredentials(serverUrl, { database });
  const appUrl = withCredentials(serverUrl, { user: appRole, password: appPassword, database });
  const owner = createDatabase(ownerUrl, { max: 2 });
  await migrateDatabase(owner.db, MIGRATIONS_DIR);
  await grantAppRole(owner.pool, { role: appRole, password: appPassword });

  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: BASE_URL,
    DATABASE_URL: appUrl,
    MIGRATION_DATABASE_URL: ownerUrl,
    WEB_DIST_DIR: mkdtempSync(join(tmpdir(), 'credforge-web-')),
    CREDFORGE_MASTER_KEY: randomBytes(32).toString('base64'),
    AUTH_SECRET: randomBytes(32).toString('hex'),
    STORAGE_LOCAL_DIR: mkdtempSync(join(tmpdir(), 'credforge-files-')),
    ...env,
  });
  const { db, pool } = createDatabase(appUrl, { max: 5 });
  const outbox = createMemoryOutbox();
  const keys = createKeyEncryption(config.masterKey);
  const auth = createAuth({ config, db, outbox, log: silent });
  const storage = createLocalStorage(
    config.storage.driver === 'local' ? config.storage.localDir : mkdtempSync(join(tmpdir(), 'x')),
  );
  const routes: { method: string; url: string }[] = [];
  const app = await buildApp({
    config,
    logger: false,
    checkDatabase: async () => {
      await pool.query('select 1');
    },
    services: { config, db, auth, outbox, keys, storage },
    onRoute: (route) => {
      for (const method of [route.method].flat()) routes.push({ method, url: route.url });
    },
  });
  await app.ready();

  return {
    app,
    /** Every registered route (method and URL pattern). */
    routes,
    config,
    db,
    /** The owner connection, for setup that the app role can't do and for assertions. */
    ownerDb: owner.db,
    ownerPool: owner.pool,
    appPool: pool,
    outbox,
    keys,
    auth,
    storage,
    async close() {
      await app.close();
      await pool.end();
      await owner.pool.end();
      const cleanup = new pg.Client({ connectionString: serverUrl });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${database} with (force)`);
      await cleanup.query(`drop role if exists ${appRole}`);
      await cleanup.end();
    },
  };
}
