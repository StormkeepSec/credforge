import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseMailbox } from '../src/config';

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

const p256 = () =>
  generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ format: 'der', type: 'spki' })
    .toString('base64');

describe('M3 settings', () => {
  it('uses local storage by default: /data/uploads in production', () => {
    expect(loadConfig(production).storage).toEqual({
      driver: 'local',
      localDir: expect.any(String),
    });
    expect(loadConfig(production).storage).toMatchObject({
      localDir: expect.stringMatching(/[\\/]data[\\/]uploads$/),
    });
  });

  it('needs a region, bucket and key for s3', () => {
    const issues = issuesFor({ ...production, STORAGE_DRIVER: 's3' });
    for (const name of ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      expect(issues).toContain(`${name}: is required for STORAGE_DRIVER=s3`);
    }
    const config = loadConfig({
      ...production,
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'https://nyc3.digitaloceanspaces.com',
      S3_REGION: 'nyc3',
      S3_BUCKET: 'credforge-prod',
      S3_ACCESS_KEY_ID: 'DO00EXAMPLE',
      S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(config.storage).toEqual({
      driver: 's3',
      endpoint: 'https://nyc3.digitaloceanspaces.com',
      region: 'nyc3',
      bucket: 'credforge-prod',
      accessKeyId: 'DO00EXAMPLE',
      secretAccessKey: 'secret',
      forcePathStyle: false,
    });
  });

  it('needs an API key and a sender for SendGrid', () => {
    const issues = issuesFor({ ...production, EMAIL_TRANSPORT: 'sendgrid' });
    expect(issues).toContain('SENDGRID_API_KEY: is required for EMAIL_TRANSPORT=sendgrid');
    expect(issues).toContain(
      'EMAIL_FROM: is required in production, e.g. credforge <awards@credforge.app>',
    );
    const config = loadConfig({
      ...production,
      EMAIL_TRANSPORT: 'sendgrid',
      SENDGRID_API_KEY: 'SG.test',
      EMAIL_FROM: 'credforge <awards@credforge.app>',
    });
    expect(config.email).toMatchObject({ transport: 'sendgrid', sendgridApiKey: 'SG.test' });
  });

  it('accepts only a P-256 key for the Event Webhook', () => {
    const key = p256();
    expect(
      loadConfig({ ...production, SENDGRID_WEBHOOK_PUBLIC_KEY: key }).email
        .sendgridWebhookPublicKey,
    ).toBe(key);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');
    for (const bad of [rsa, 'not-a-key']) {
      expect(issuesFor({ ...production, SENDGRID_WEBHOOK_PUBLIC_KEY: bad })).toEqual([
        expect.stringContaining('SENDGRID_WEBHOOK_PUBLIC_KEY'),
      ]);
    }
  });

  it('reads the daily send limit (0 means none)', () => {
    expect(loadConfig(production).defaultOrgDailySendLimit).toBe(1000);
    expect(
      loadConfig({ ...production, DEFAULT_ORG_DAILY_SEND_LIMIT: '0' }).defaultOrgDailySendLimit,
    ).toBe(0);
    expect(issuesFor({ ...production, DEFAULT_ORG_DAILY_SEND_LIMIT: '-1' })).toEqual([
      expect.stringContaining('DEFAULT_ORG_DAILY_SEND_LIMIT'),
    ]);
  });

  it('parses senders', () => {
    expect(parseMailbox('credforge <awards@credforge.app>')).toEqual({
      name: 'credforge',
      address: 'awards@credforge.app',
    });
    expect(parseMailbox('"Example, Inc." <a@example.org>')).toEqual({
      name: 'Example, Inc.',
      address: 'a@example.org',
    });
    expect(parseMailbox('awards@credforge.app')).toEqual({ address: 'awards@credforge.app' });
    expect(parseMailbox('not an address')).toBeUndefined();
    expect(issuesFor({ ...production, EMAIL_FROM: 'nobody' })).toEqual([
      expect.stringContaining('EMAIL_FROM'),
    ]);
  });
});
