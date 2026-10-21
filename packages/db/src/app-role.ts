import pg from 'pg';

/** Tables the app's role may read and append to, but never change or delete from. */
export const APPEND_ONLY_TABLES = ['audit_event'] as const;

/**
 * Tables the app's role may append to and read only some columns of: known-CSAM evidence (design
 * plan §6.5), whose sealed `envelope` only the database owner reads (`cli.js export-evidence`).
 */
export const WRITE_ONLY_COLUMNS: Record<string, { readable: string[] }> = {
  moderation_evidence: {
    readable: [
      'id',
      'org_id',
      'item_id',
      'file_id',
      'content_sha256',
      'source',
      'matcher',
      'key_fingerprint',
      'envelope_sha256',
      'created_at',
    ],
  },
};

export interface AppRoleOptions {
  /** Login role the app and worker connect as (the user in DATABASE_URL). */
  role: string;
  /** Its password. Set (or reset) on every run, so DATABASE_URL stays the source of truth. */
  password: string;
  /** Schemas owned by other libraries that the app uses with full DML (the job queue). */
  extraSchemas?: string[];
}

/**
 * Creates or updates the restricted database role the app and worker connect as, and re-grants
 * its privileges. Run by `migrate` as the database owner after every migration, so new tables
 * are covered.
 *
 * The role gets SELECT, INSERT, UPDATE and DELETE on the app's tables, except the append-only
 * tables (only SELECT and INSERT). It owns nothing and can't run DDL.
 */
export async function grantAppRole(owner: pg.Pool | pg.Client, options: AppRoleOptions) {
  const role = pg.escapeIdentifier(options.role);
  const password = pg.escapeLiteral(options.password);

  const existing = await owner.query('select 1 from pg_roles where rolname = $1', [options.role]);
  if (existing.rowCount === 0) {
    try {
      await owner.query(`create role ${role} login password ${password}`);
    } catch (error) {
      // Another process created it first (parallel test databases share roles).
      if ((error as { code?: string }).code !== '42710') throw error;
      await owner.query(`alter role ${role} login password ${password}`);
    }
  } else {
    await owner.query(`alter role ${role} login password ${password}`);
  }

  const database = pg.escapeIdentifier(
    (await owner.query<{ db: string }>('select current_database() as db')).rows[0]?.db ?? '',
  );
  const statements = [
    `grant connect on database ${database} to ${role}`,
    `grant usage on schema public to ${role}`,
    `grant select, insert, update, delete on all tables in schema public to ${role}`,
    `grant usage, select on all sequences in schema public to ${role}`,
    ...APPEND_ONLY_TABLES.map(
      (table) => `revoke update, delete, truncate on ${pg.escapeIdentifier(table)} from ${role}`,
    ),
    ...Object.entries(WRITE_ONLY_COLUMNS).flatMap(([table, { readable }]) => [
      `revoke all on ${pg.escapeIdentifier(table)} from ${role}`,
      `grant insert on ${pg.escapeIdentifier(table)} to ${role}`,
      `grant select (${readable.map((column) => pg.escapeIdentifier(column)).join(', ')}) on ${pg.escapeIdentifier(table)} to ${role}`,
    ]),
  ];
  for (const schema of options.extraSchemas ?? []) {
    const name = pg.escapeIdentifier(schema);
    statements.push(
      `grant usage on schema ${name} to ${role}`,
      `grant select, insert, update, delete on all tables in schema ${name} to ${role}`,
      `grant usage, select, update on all sequences in schema ${name} to ${role}`,
      `grant execute on all functions in schema ${name} to ${role}`,
    );
  }
  for (const statement of statements) await owner.query(statement);
}

/** The login user and password in a postgres:// connection string. */
export function connectionUser(connectionString: string): { user: string; password: string } {
  const url = new URL(connectionString);
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}
