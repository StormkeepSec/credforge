import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const production = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://credforge.app',
  DATABASE_URL: 'postgres://credforge:secret@db:5432/credforge',
  AUTH_SECRET: 'a-long-random-production-auth-secret-value',
  CREDFORGE_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
  EMAIL_TRANSPORT: 'log',
};

function issuesFor(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe('loadConfig', () => {
  it('works with no settings in development', () => {
    const config = loadConfig({});
    expect(config.env).toBe('development');
    expect(config.publicBaseUrl).toBe('http://localhost:5173');
    expect(config.port).toBe(3000);
    expect(config.trustProxy).toBe(false);
  });

  it('requires the base URL and database in production', () => {
    const issues = issuesFor({ NODE_ENV: 'production' });
    expect(issues.some((issue) => issue.startsWith('PUBLIC_BASE_URL'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('DATABASE_URL'))).toBe(true);
  });

  it('normalizes the public base URL to an origin', () => {
    expect(
      loadConfig({ ...production, PUBLIC_BASE_URL: 'https://credforge.app/' }).publicBaseUrl,
    ).toBe('https://credforge.app');
  });

  it('rejects a base URL with a path', () => {
    expect(issuesFor({ ...production, PUBLIC_BASE_URL: 'https://example.org/badges' })).toEqual([
      expect.stringContaining('origin only'),
    ]);
  });

  it('requires https in production except on localhost', () => {
    expect(issuesFor({ ...production, PUBLIC_BASE_URL: 'http://credforge.app' })).toEqual([
      expect.stringContaining('https://'),
    ]);
    expect(issuesFor({ ...production, PUBLIC_BASE_URL: 'http://localhost:3000' })).toEqual([]);
  });

  it('parses TRUST_PROXY as boolean or address list', () => {
    expect(loadConfig({ ...production, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ...production, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...production, TRUST_PROXY: '172.16.0.0/12' }).trustProxy).toBe(
      '172.16.0.0/12',
    );
  });

  it('reads NAME_FILE secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'credforge-config-'));
    const file = join(dir, 'database_url');
    writeFileSync(file, 'postgres://from-file@db:5432/credforge\n');
    const { DATABASE_URL: _unused, ...rest } = production;
    expect(loadConfig({ ...rest, DATABASE_URL_FILE: file }).databaseUrl).toBe(
      'postgres://from-file@db:5432/credforge',
    );
  });

  it('rejects setting both NAME and NAME_FILE', () => {
    expect(issuesFor({ ...production, DATABASE_URL_FILE: '/run/secrets/x' })).toEqual([
      expect.stringContaining('not both'),
    ]);
  });
});

describe('M2 settings', () => {
  it('uses development defaults: restricted app role, owner for migrations, Mailpit', () => {
    const config = loadConfig({});
    expect(config.databaseUrl).toContain('credforge_app:');
    expect(config.migrationDatabaseUrl).toContain('credforge:credforge@');
    expect(config.email).toMatchObject({ transport: 'smtp', smtpUrl: 'smtp://localhost:1025' });
    expect(config.masterKey).toHaveLength(32);
    expect(config.requireMfaForAdmins).toBe(true);
    expect(config.signupMode).toBe('approval');
    expect(config.oauth).toEqual({ google: undefined, microsoft: undefined });
  });

  it('requires the secrets and an email transport in production', () => {
    const { AUTH_SECRET: _a, CREDFORGE_MASTER_KEY: _m, EMAIL_TRANSPORT: _e, ...bare } = production;
    const issues = issuesFor(bare);
    for (const name of ['AUTH_SECRET', 'CREDFORGE_MASTER_KEY', 'EMAIL_TRANSPORT']) {
      expect(issues).toContainEqual(expect.stringMatching(new RegExp(`^${name}: is required`)));
    }
  });

  it('migrates as DATABASE_URL unless MIGRATION_DATABASE_URL is set', () => {
    expect(loadConfig(production).migrationDatabaseUrl).toBe(production.DATABASE_URL);
    expect(
      loadConfig({ ...production, MIGRATION_DATABASE_URL: 'postgres://owner:x@db/credforge' })
        .migrationDatabaseUrl,
    ).toBe('postgres://owner:x@db/credforge');
  });

  it('accepts a 32-byte master key as base64, base64url or hex', () => {
    const bytes = Buffer.alloc(32, 9);
    for (const encoded of [
      bytes.toString('base64'),
      bytes.toString('base64url'),
      bytes.toString('hex'),
    ]) {
      expect(loadConfig({ ...production, CREDFORGE_MASTER_KEY: encoded }).masterKey).toEqual(bytes);
    }
    expect(
      issuesFor({ ...production, CREDFORGE_MASTER_KEY: Buffer.alloc(16).toString('base64') }),
    ).toEqual([expect.stringContaining('CREDFORGE_MASTER_KEY: must be 32 random bytes')]);
  });

  it('reads the master key from a Docker secret file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'credforge-config-'));
    const file = join(dir, 'master_key');
    writeFileSync(file, `${Buffer.alloc(32, 3).toString('base64')}\n`);
    const { CREDFORGE_MASTER_KEY: _unused, ...rest } = production;
    expect(loadConfig({ ...rest, CREDFORGE_MASTER_KEY_FILE: file }).masterKey).toEqual(
      Buffer.alloc(32, 3),
    );
  });

  it('enables a sign-in provider only with both its client id and secret', () => {
    expect(
      loadConfig({ ...production, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }).oauth
        .google,
    ).toEqual({ clientId: 'id', clientSecret: 'secret' });
    expect(issuesFor({ ...production, MICROSOFT_CLIENT_ID: 'id' })).toEqual([
      expect.stringContaining('MICROSOFT_CLIENT_SECRET: is required'),
    ]);
    expect(
      loadConfig({ ...production, MICROSOFT_CLIENT_ID: 'id', MICROSOFT_CLIENT_SECRET: 's' }).oauth
        .microsoft,
    ).toEqual({ clientId: 'id', clientSecret: 's', tenantId: 'common' });
  });

  it('needs SMTP_URL for smtp, and EMAIL_FROM in production', () => {
    expect(issuesFor({ ...production, EMAIL_TRANSPORT: 'smtp' }).sort()).toEqual([
      expect.stringContaining('EMAIL_FROM'),
      expect.stringContaining('SMTP_URL'),
    ]);
  });

  it('parses SIGNUP_MODE and REQUIRE_MFA_FOR_ADMINS', () => {
    const config = loadConfig({
      ...production,
      SIGNUP_MODE: 'invite',
      REQUIRE_MFA_FOR_ADMINS: 'false',
    });
    expect(config.signupMode).toBe('invite');
    expect(config.requireMfaForAdmins).toBe(false);
    expect(issuesFor({ ...production, SIGNUP_MODE: 'everyone' })).toEqual([
      expect.stringContaining('SIGNUP_MODE'),
    ]);
  });
});
