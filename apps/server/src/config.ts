import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Defaults applied only when NODE_ENV=development, so `pnpm dev` works with no setup. */
const DEVELOPMENT_DEFAULTS: Record<string, string> = {
  PUBLIC_BASE_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://credforge:credforge@localhost:5432/credforge',
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

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_BASE_URL: publicBaseUrl,
    DATABASE_URL: z
      .string({ error: 'is required' })
      .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: trustProxy,
    ALLOW_PUBLIC_BASE_URL_CHANGE: z.stringbool().default(false),
    LANDING_PAGE: z.stringbool().default(true),
    WEB_DIST_DIR: z.string().optional(),
    MIGRATIONS_DIR: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const { protocol, hostname } = new URL(env.PUBLIC_BASE_URL);
    if (env.NODE_ENV === 'production' && protocol !== 'https:' && !LOCAL_HOSTNAMES.has(hostname)) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_BASE_URL'],
        message: 'must use https:// in production (http:// is only allowed for localhost)',
      });
    }
  });

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  /** Origin every public URL is built from, e.g. https://credforge.app. Permanent once set. */
  publicBaseUrl: string;
  databaseUrl: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  trustProxy: boolean | string;
  allowPublicBaseUrlChange: boolean;
  landingPage: boolean;
  /** Built issuer app (apps/web/dist). */
  webDistDir: string;
  /** SQL migrations (packages/db/migrations). */
  migrationsDir: string;
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
  const isDevelopment = (defined.NODE_ENV ?? 'development') === 'development';
  const input = isDevelopment ? { ...DEVELOPMENT_DEFAULTS, ...defined } : defined;

  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const env = result.data;
  // Relative to this module: apps/server/src in development, apps/server/dist when built.
  const here = import.meta.dirname;
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    allowPublicBaseUrlChange: env.ALLOW_PUBLIC_BASE_URL_CHANGE,
    landingPage: env.LANDING_PAGE,
    webDistDir: env.WEB_DIST_DIR ?? resolve(here, '../../web/dist'),
    migrationsDir: env.MIGRATIONS_DIR ?? resolve(here, '../../../packages/db/migrations'),
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
