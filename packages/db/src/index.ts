import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

// Query helpers, re-exported so every package uses this package's copy of drizzle-orm.
export { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
export * from './schema';

export interface DatabaseOptions {
  /** Maximum pool size. */
  max?: number;
  /** Shown in pg_stat_activity, e.g. `credforge-app`. */
  applicationName?: string;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Database = ReturnType<typeof createDatabase>['db'];

/** Applies pending SQL migrations from `migrationsFolder` (packages/db/migrations). */
export async function migrateDatabase(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
