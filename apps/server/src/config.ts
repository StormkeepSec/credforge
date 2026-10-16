import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SIGNUP_MODES, type SignupMode } from '@credforge/contracts';
import { z } from 'zod';

/**
 * Defaults applied only when NODE_ENV=development, so `pnpm dev` works with no setup.
 * The app connects as a restricted role that `migrate` creates (see packages/db/src/app-role.ts);
 * migrations run as the database owner from compose.dev.yml.
 */
const DEVELOPMENT_DEFAULTS: Record<string, string> = {
  PUBLIC_BASE_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://credforge_app:credforge_app@localhost:5432/credforge',
  MIGRATION_DATABASE_URL: 'postgres://credforge:credforge@localhost:5432/credforge',
  EMAIL_TRANSPORT: 'smtp',
  SMTP_URL: 'smtp://localhost:1025', // Mailpit (compose.dev.yml)
  // So the report link, security.txt and the legal pages' contacts show in development.
  ABUSE_EMAIL: 'abuse@credforge.test',
  SECURITY_EMAIL: 'security@credforge.test',
};

/** Used outside production when the variable isn't set. Never valid in production. */
const NON_PRODUCTION_SECRETS = {
  AUTH_SECRET: 'credforge-development-auth-secret-do-not-use-in-production',
  // base64 of the 32 ASCII bytes "credforge-dev-master-key-32bytes"
  CREDFORGE_MASTER_KEY: 'Y3JlZGZvcmdlLWRldi1tYXN0ZXIta2V5LTMyYnl0ZXM=',
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const publicBaseUrl = z
  .string({ error: 'is required, e.g. https://credforge.app' })
  .trim()
  .transform((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'must be an absolute URL, e.g. https://credforge.app',
      });
      return z.NEVER;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      ctx.addIssue({ code: 'custom', message: 'must start with https://' });
      return z.NEVER;
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be an origin only (no path, query or credentials), e.g. https://credforge.app',
      });
      return z.NEVER;
    }
    return url.origin;
  });

/** Fastify's trustProxy: true/false, or a comma-separated list of proxy IPs/CIDRs. */
const trustProxy = z
  .string()
  .trim()
  .default('false')
  .transform((value): boolean | string => {
    if (value === 'true') return true;
    if (value === 'false' || value === '') return false;
    return value;
  });

const postgresUrl = z
  .string({ error: 'is required' })
  .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string');

/** 32 bytes as base64, base64url or hex, e.g. the output of `openssl rand -base64 32`. */
export const masterKey = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const bytes = /^[0-9a-f]{64}$/i.test(value)
      ? Buffer.from(value, 'hex')
      : /^[A-Za-z0-9+/_-]{43}={0,1}$/.test(value)
        ? Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
        : undefined;
    if (bytes?.length !== 32) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be 32 random bytes in base64 or hex, e.g. the output of `openssl rand -base64 32`',
      });
      return z.NEVER;
    }
    return bytes;
  });

/**
 * SendGrid's Event Webhook verification key, as shown in its settings: base64 of a DER
 * (SubjectPublicKeyInfo) ECDSA P-256 public key. A PEM block is accepted too.
 */
const sendgridPublicKey = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const key = value.includes('BEGIN PUBLIC KEY')
        ? createPublicKey(value)
        : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
      return (
        key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
      );
    } catch {
      return false;
    }
  }, 'must be the ECDSA (P-256) verification key from the SendGrid Event Webhook settings');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_BASE_URL: publicBaseUrl,
    DATABASE_URL: postgresUrl,
    MIGRATION_DATABASE_URL: postgresUrl.optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: trustProxy,
    ALLOW_PUBLIC_BASE_URL_CHANGE: z.stringbool().default(false),
    LANDING_PAGE: z.stringbool().default(true),
    WEB_DIST_DIR: z.string().optional(),
    MIGRATIONS_DIR: z.string().optional(),

    AUTH_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
    CREDFORGE_MASTER_KEY: masterKey.optional(),

    EMAIL_TRANSPORT: z.enum(['sendgrid', 'smtp', 'log']).optional(),
    SMTP_URL: z
      .string()
      .regex(/^smtps?:\/\//, 'must be an smtp:// or smtps:// URL')
      .optional(),
    EMAIL_FROM: z.string().trim().optional(),
    SENDGRID_API_KEY: z.string().trim().optional(),
    SENDGRID_WEBHOOK_PUBLIC_KEY: sendgridPublicKey.optional(),
    DEFAULT_ORG_DAILY_SEND_LIMIT: z.coerce
      .number({ error: 'must be a whole number' })
      .int('must be a whole number')
      .min(0, 'must be 0 (no limit) or more')
      .default(1000),
    VERIFY_RATE_LIMIT: z.coerce
      .number({ error: 'must be a whole number' })
      .int('must be a whole number')
      .min(0, 'must be 0 (no limit) or more')
      .default(20),
    API_RATE_LIMIT: z.coerce
      .number({ error: 'must be a whole number' })
      .int('must be a whole number')
      .min(0, 'must be 0 (no limit) or more')
      .default(300),
    CLAIM_RATE_LIMIT: z.coerce
      .number({ error: 'must be a whole number' })
      .int('must be a whole number')
      .min(0, 'must be 0 (no limit) or more')
      .default(30),
    AUTH_RATE_LIMIT: z.stringbool().optional(),
    ABUSE_EMAIL: z.email('must be an email address').optional(),
    PRIVACY_EMAIL: z.email('must be an email address').optional(),
    SECURITY_EMAIL: z.email('must be an email address').optional(),
    OPERATOR_NAME: z.string().trim().max(200).optional(),
    LEGAL_PAGES_DRAFT: z.stringbool().default(true),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().trim().optional(),
    S3_ENDPOINT: z
      .string()
      .trim()
      .regex(/^https?:\/\//, 'must be a URL, e.g. https://nyc3.digitaloceanspaces.com')
      .optional(),
    S3_REGION: z.string().trim().optional(),
    S3_BUCKET: z.string().trim().optional(),
    S3_ACCESS_KEY_ID: z.string().trim().optional(),
    S3_SECRET_ACCESS_KEY: z.string().trim().optional(),
    S3_FORCE_PATH_STYLE: z.stringbool().default(false),

    GOOGLE_CLIENT_ID: z.string().trim().optional(),
    GOOGLE_CLIENT_SECRET: z.string().trim().optional(),
    MICROSOFT_CLIENT_ID: z.string().trim().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().trim().optional(),
    MICROSOFT_TENANT_ID: z.string().trim().default('common'),

    REQUIRE_MFA_FOR_ADMINS: z.stringbool().default(true),
    SIGNUP_MODE: z.enum(SIGNUP_MODES).default('approval'),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production';
    const { protocol, hostname } = new URL(env.PUBLIC_BASE_URL);
    if (production && protocol !== 'https:' && !LOCAL_HOSTNAMES.has(hostname)) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_BASE_URL'],
        message: 'must use https:// in production (http:// is only allowed for localhost)',
      });
    }
    if (production) {
      for (const name of ['AUTH_SECRET', 'CREDFORGE_MASTER_KEY', 'EMAIL_TRANSPORT'] as const) {
        if (env[name] === undefined) {
          ctx.addIssue({ code: 'custom', path: [name], message: 'is required in production' });
        }
      }
    }
    if (env.EMAIL_TRANSPORT === 'smtp' && !env.SMTP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'is required for EMAIL_TRANSPORT=smtp',
      });
    }
    if (env.EMAIL_TRANSPORT === 'sendgrid' && !env.SENDGRID_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SENDGRID_API_KEY'],
        message: 'is required for EMAIL_TRANSPORT=sendgrid',
      });
    }
    if (production && env.EMAIL_TRANSPORT && env.EMAIL_TRANSPORT !== 'log' && !env.EMAIL_FROM) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_FROM'],
        message: 'is required in production, e.g. credforge <awards@credforge.app>',
      });
    }
    if (env.EMAIL_FROM && !parseMailbox(env.EMAIL_FROM)) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_FROM'],
        message: 'must be an address or "Name <address>", e.g. credforge <awards@credforge.app>',
      });
    }
    if (env.STORAGE_DRIVER === 's3') {
      for (const name of [
        'S3_REGION',
        'S3_BUCKET',
        'S3_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY',
      ] as const) {
        if (!env[name]) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: 'is required for STORAGE_DRIVER=s3',
          });
        }
      }
    }
    for (const provider of ['GOOGLE', 'MICROSOFT'] as const) {
      const id = env[`${provider}_CLIENT_ID`];
      const secret = env[`${provider}_CLIENT_SECRET`];
      if (Boolean(id) !== Boolean(secret)) {
        ctx.addIssue({
          code: 'custom',
          path: [id ? `${provider}_CLIENT_SECRET` : `${provider}_CLIENT_ID`],
          message: `is required when ${id ? `${provider}_CLIENT_ID` : `${provider}_CLIENT_SECRET`} is set`,
        });
      }
    }
  });

/** A sender: `awards@credforge.app` or `credforge <awards@credforge.app>`. */
export interface Mailbox {
  name?: string;
  address: string;
}

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function parseMailbox(value: string): Mailbox | undefined {
  const trimmed = value.trim();
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(trimmed);
  if (named) {
    const name = (named[1] ?? '').trim().replace(/^"(.*)"$/, '$1');
    const address = (named[2] ?? '').trim();
    if (!ADDRESS.test(address)) return undefined;
    return name ? { name, address } : { address };
  }
  return ADDRESS.test(trimmed) ? { address: trimmed } : undefined;
}

export type StorageConfig =
  | { driver: 'local'; localDir: string }
  | {
      driver: 's3';
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  /** Origin every public URL is built from, e.g. https://credforge.app. Permanent once set. */
  publicBaseUrl: string;
  /** The app's restricted role (app and worker). */
  databaseUrl: string;
  /** The database owner, used by `migrate` and the CLI. Defaults to `databaseUrl`. */
  migrationDatabaseUrl: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  trustProxy: boolean | string;
  allowPublicBaseUrlChange: boolean;
  landingPage: boolean;
  /** Built issuer app (apps/web/dist). */
  webDistDir: string;
  /** SQL migrations (packages/db/migrations). */
  migrationsDir: string;
  /** Signs sessions and encrypts TOTP secrets. Must never change once users enable 2FA. */
  authSecret: string;
  /** 32 bytes; encrypts issuer private keys (design plan §6.2). */
  masterKey: Buffer;
  email: {
    transport: 'sendgrid' | 'smtp' | 'log';
    smtpUrl?: string;
    sendgridApiKey?: string;
    /** Verifies SendGrid's signed Event Webhook (base64 DER public key). Unset: webhook off. */
    sendgridWebhookPublicKey?: string;
    /** e.g. `credforge <awards@credforge.app>`. */
    from: string;
  };
  /** Award emails per org in any 24 hours, unless a platform admin set the org's own; 0 = no limit. */
  defaultOrgDailySendLimit: number;
  /** Verifications (the /verify page and POST /api/v1/verify) per client IP per minute; 0 = no limit. */
  verifyRateLimit: number;
  /** Requests per API key per minute; 0 = no limit. */
  apiRateLimit: number;
  /** Claim and invitation links opened per client IP per minute; 0 = no limit. */
  claimRateLimit: number;
  /** Better Auth's sign-in, sign-up, reset and second-factor limits (on in production). */
  authRateLimit: boolean;
  /** Where "Report a problem" on public pages goes; unset hides the link. */
  abuseEmail?: string;
  /** For privacy requests on /privacy; defaults to the abuse address. */
  privacyEmail?: string;
  /** For vulnerability reports: /.well-known/security.txt and the privacy policy. */
  securityEmail?: string;
  /** Who runs this instance, as the privacy policy and terms name it. */
  operatorName?: string;
  /** The privacy policy and terms are drafts awaiting review: they say so at the top. */
  legalPagesDraft: boolean;
  storage: StorageConfig;
  oauth: {
    google?: OAuthClient;
    microsoft?: OAuthClient & { tenantId: string };
  };
  /** Owners, admins and platform admins need a credforge second factor after any sign-in. */
  requireMfaForAdmins: boolean;
  signupMode: SignupMode;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Resolves `NAME_FILE` variables (Docker secrets) into `NAME`, reading the file's contents.
 * Setting both `NAME` and `NAME_FILE` is an error.
 */
export function resolveFileSecrets(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source };
  const issues: string[] = [];
  for (const [key, path] of Object.entries(source)) {
    if (!key.endsWith('_FILE') || !path) continue;
    const name = key.slice(0, -'_FILE'.length);
    if (source[name] !== undefined) {
      issues.push(`${name}: set either ${name} or ${key}, not both`);
      continue;
    }
    try {
      env[name] = readFileSync(path, 'utf8').trim();
    } catch {
      issues.push(`${key}: cannot read file ${path}`);
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return env;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const resolved = resolveFileSecrets(source);
  const defined = Object.fromEntries(
    Object.entries(resolved).filter(([, value]) => value !== undefined && value !== ''),
  );
  const nodeEnv = defined.NODE_ENV ?? 'development';
  const input = {
    ...(nodeEnv !== 'production' && NON_PRODUCTION_SECRETS),
    ...(nodeEnv === 'development' && DEVELOPMENT_DEFAULTS),
    ...defined,
  };

  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const env = result.data;
  // Relative to this module: apps/server/src in development, apps/server/dist when built.
  const here = import.meta.dirname;
  const host = new URL(env.PUBLIC_BASE_URL).hostname;
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    databaseUrl: env.DATABASE_URL,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    allowPublicBaseUrlChange: env.ALLOW_PUBLIC_BASE_URL_CHANGE,
    landingPage: env.LANDING_PAGE,
    webDistDir: env.WEB_DIST_DIR ?? resolve(here, '../../web/dist'),
    migrationsDir: env.MIGRATIONS_DIR ?? resolve(here, '../../../packages/db/migrations'),
    // Both are set: required in production, defaulted otherwise (checked above).
    authSecret: env.AUTH_SECRET as string,
    masterKey: env.CREDFORGE_MASTER_KEY as Buffer,
    email: {
      transport: env.EMAIL_TRANSPORT ?? 'log',
      smtpUrl: env.SMTP_URL,
      sendgridApiKey: env.SENDGRID_API_KEY,
      sendgridWebhookPublicKey: env.SENDGRID_WEBHOOK_PUBLIC_KEY,
      from:
        env.EMAIL_FROM ?? `credforge <no-reply@${host === 'localhost' ? 'localhost.test' : host}>`,
    },
    defaultOrgDailySendLimit: env.DEFAULT_ORG_DAILY_SEND_LIMIT,
    verifyRateLimit: env.VERIFY_RATE_LIMIT,
    apiRateLimit: env.API_RATE_LIMIT,
    claimRateLimit: env.CLAIM_RATE_LIMIT,
    authRateLimit: env.AUTH_RATE_LIMIT ?? env.NODE_ENV === 'production',
    abuseEmail: env.ABUSE_EMAIL,
    privacyEmail: env.PRIVACY_EMAIL ?? env.ABUSE_EMAIL,
    securityEmail: env.SECURITY_EMAIL,
    operatorName: env.OPERATOR_NAME,
    legalPagesDraft: env.LEGAL_PAGES_DRAFT,
    storage:
      env.STORAGE_DRIVER === 's3'
        ? {
            driver: 's3',
            endpoint: env.S3_ENDPOINT,
            region: env.S3_REGION as string,
            bucket: env.S3_BUCKET as string,
            accessKeyId: env.S3_ACCESS_KEY_ID as string,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
            forcePathStyle: env.S3_FORCE_PATH_STYLE,
          }
        : {
            driver: 'local',
            localDir: resolve(
              env.STORAGE_LOCAL_DIR ??
                (env.NODE_ENV === 'production'
                  ? '/data/uploads'
                  : resolve(here, '../../../data/uploads')),
            ),
          },
    oauth: {
      google:
        env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
          : undefined,
      microsoft:
        env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
          ? {
              clientId: env.MICROSOFT_CLIENT_ID,
              clientSecret: env.MICROSOFT_CLIENT_SECRET,
              tenantId: env.MICROSOFT_TENANT_ID,
            }
          : undefined,
    },
    requireMfaForAdmins: env.REQUIRE_MFA_FOR_ADMINS,
    signupMode: env.SIGNUP_MODE,
  };
}

/** Loads config for an entrypoint; prints a readable error and exits on failure. */
export function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
