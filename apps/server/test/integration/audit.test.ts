import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKeyEncryption } from '../../src/crypto/key-encryption';
import { enforceMasterKey, MasterKeyMismatchError } from '../../src/instance';
import { createTestEnvironment, type TestEnvironment } from './support/harness';

let env: TestEnvironment;
beforeAll(async () => {
  env = await createTestEnvironment();
});
afterAll(async () => {
  await env?.close();
});

async function sqlError(pool: { query: (sql: string) => Promise<unknown> }, sql: string) {
  try {
    await pool.query(sql);
  } catch (error) {
    return error as { code?: string; message: string };
  }
  return null;
}

describe('append-only audit log', () => {
  it("lets the app's role read and append, never change or delete", async () => {
    await env.appPool.query(
      `insert into audit_event (actor_type, action) values ('system', 'test.appended')`,
    );
    const rows = await env.appPool.query(
      `select action from audit_event where action = 'test.appended'`,
    );
    expect(rows.rowCount).toBe(1);

    for (const statement of [
      `update audit_event set action = 'tampered'`,
      'delete from audit_event',
      'truncate audit_event',
    ]) {
      const error = await sqlError(env.appPool, statement);
      expect(error?.code, statement).toBe('42501'); // insufficient_privilege
      expect(error?.message, statement).toContain('permission denied');
    }
  });

  it('stops even the owner role, with triggers', async () => {
    for (const statement of [
      `update audit_event set action = 'tampered'`,
      'delete from audit_event',
      'truncate audit_event',
    ]) {
      const error = await sqlError(env.ownerPool, statement);
      expect(error?.message, statement).toContain('audit_event is append-only');
    }
  });

  it("doesn't let the app's role run DDL", async () => {
    const error = await sqlError(
      env.appPool,
      'drop trigger audit_event_no_update_delete on audit_event',
    );
    expect(error?.code).toBe('42501');
  });
});

describe('master key check', () => {
  it('records the key on first start and refuses a different one later', async () => {
    const log = { info() {} };
    await enforceMasterKey(env.db, env.keys, log);
    await enforceMasterKey(env.db, env.keys, log); // same key: fine
    const other = createKeyEncryption(Buffer.alloc(32, 7));
    await expect(enforceMasterKey(env.db, other, log)).rejects.toBeInstanceOf(
      MasterKeyMismatchError,
    );
  });
});
