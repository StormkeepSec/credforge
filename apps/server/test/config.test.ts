import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const production = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://credforge.app',
  DATABASE_URL: 'postgres://credforge:secret@db:5432/credforge',
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
