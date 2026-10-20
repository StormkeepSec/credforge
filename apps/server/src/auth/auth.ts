import {
  account,
  type Database,
  eq,
  session,
  twoFactor as twoFactorTable,
  user,
  verification,
} from '@credforge/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware, isAPIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import type { Logger } from 'pino';
import { type AuditRequestInfo, recordAudit } from '../audit/audit';
import type { Config } from '../config';
import {
  existingAccountMessage,
  resetPasswordMessage,
  verifyEmailMessage,
} from '../email/messages';
import type { EmailOutbox } from '../email/outbox';
import { mayCreateAccountByInvitation } from '../recipients/addresses';
import { isMicrosoftEmailVerified, stripProviderTokens } from './providers';

/** Set by the Fastify bridge from `request.ip` (which honors TRUST_PROXY); clients can't set it. */
export const CLIENT_IP_HEADER = 'x-credforge-client-ip';

export const AUTH_BASE_PATH = '/api/auth';

/**
 * Tighter limits for the endpoints worth guessing at or that send email (per client IP, per
 * minute). Two-step codes: 10 tries a minute against a million codes that change every 30 s.
 */
export const AUTH_RATE_LIMITS: Record<string, { window: number; max: number }> = {
  '/sign-in/email': { window: 60, max: 10 },
  '/sign-up/email': { window: 60, max: 5 },
  '/request-password-reset': { window: 60, max: 5 },
  '/reset-password': { window: 60, max: 10 },
  '/send-verification-email': { window: 60, max: 5 },
  '/change-password': { window: 60, max: 10 },
  '/two-factor/verify-totp': { window: 60, max: 10 },
  '/two-factor/verify-backup-code': { window: 60, max: 10 },
  '/two-factor/enable': { window: 60, max: 10 },
  '/two-factor/disable': { window: 60, max: 10 },
};

/** Passwords: NIST SP 800-63B allows 8+, credforge asks for a little more. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export interface AuthDependencies {
  config: Config;
  db: Database;
  outbox: EmailOutbox;
  log: Pick<Logger, 'error' | 'warn' | 'info'>;
}

/** The subset of Better Auth's endpoint context the hooks below read. */
interface HookContext {
  path?: string;
  params?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Headers;
  request?: Request;
  context?: {
    session?: {
      session: { token: string };
      user: { id: string; email: string; twoFactorEnabled?: boolean | null };
    } | null;
    newSession?: { session: { token: string }; user: { id: string; email: string } } | null;
  };
}

function requestInfo(ctx: HookContext | null | undefined): AuditRequestInfo {
  const headers = ctx?.headers ?? ctx?.request?.headers;
  return {
    ip: headers?.get(CLIENT_IP_HEADER) ?? null,
    userAgent: headers?.get('user-agent') ?? null,
  };
}

/** How a new session was started, from the Better Auth endpoint that created it. */
function signInMethod(ctx: HookContext | null | undefined): string {
  const path = ctx?.path ?? '';
  if (path === '/sign-in/email' || path === '/sign-up/email') return 'password';
  if (path.startsWith('/callback/')) return ctx?.params?.id ?? path.slice('/callback/'.length);
  if (path === '/two-factor/verify-totp') return 'password+totp';
  if (path === '/two-factor/verify-backup-code') return 'password+backup_code';
  if (path === '/verify-email') return 'email_link';
  return path || 'other';
}

export function createAuth({ config, db, outbox, log }: AuthDependencies) {
  const { publicBaseUrl } = config;
  const background = (promise: Promise<unknown>, what: string) => {
    promise.catch((err: unknown) => log.error({ err }, `${what} failed`));
  };

  const auditAccountOwner = async (
    row: { userId?: unknown; providerId?: unknown },
    action: string,
    ctx: HookContext | null | undefined,
  ) => {
    const [owner] = await db
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(eq(user.id, String(row.userId)));
    if (owner) await auditUser(owner, action, ctx, { provider: row.providerId });
  };

  const auditUser = (
    userRow: { id: string; email: string },
    action: string,
    ctx: HookContext | null | undefined,
    data?: Record<string, unknown>,
  ) =>
    recordAudit(db, {
      actor: { type: 'user', id: userRow.id, label: userRow.email },
      action,
      target: { type: 'user', id: userRow.id },
      data,
      request: requestInfo(ctx),
    });

  const socialProviders: Parameters<typeof betterAuth>[0]['socialProviders'] = {};
  if (config.oauth.google) {
    socialProviders.google = {
      clientId: config.oauth.google.clientId,
      clientSecret: config.oauth.google.clientSecret,
      // Basic scopes only (openid email profile, the provider's default).
      requireEmailVerification: true,
    };
  }
  if (config.oauth.microsoft) {
    socialProviders.microsoft = {
      clientId: config.oauth.microsoft.clientId,
      clientSecret: config.oauth.microsoft.clientSecret,
      tenantId: config.oauth.microsoft.tenantId,
      // Basic OpenID scopes; no Graph access, no refresh token, no profile photo download.
      disableDefaultScope: true,
      scope: ['openid', 'profile', 'email'],
      disableProfilePhoto: true,
      // Unverified email: no session until the user confirms credforge's own email.
      requireEmailVerification: true,
      mapProfileToUser: (profile) => ({
        emailVerified: isMicrosoftEmailVerified(profile as unknown as Record<string, unknown>),
      }),
    };
  }

  return betterAuth({
    appName: 'credforge',
    baseURL: publicBaseUrl,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    trustedOrigins: [publicBaseUrl],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user, session, account, verification, twoFactor: twoFactorTable },
    }),
    advanced: {
      database: { generateId: 'uuid' },
      cookiePrefix: 'credforge',
      useSecureCookies: publicBaseUrl.startsWith('https://'),
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    telemetry: { enabled: false },
    rateLimit: {
      // Per client IP, in memory: one app process (design plan §2). On in production
      // (AUTH_RATE_LIMIT); off in development, where the e2e tests sign up many accounts.
      enabled: config.authRateLimit,
      window: 60,
      max: 100,
      customRules: AUTH_RATE_LIMITS,
    },

    user: {
      additionalFields: {
        isPlatformAdmin: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
      /**
       * SIGNUP_MODE=invite: only people with a pending invitation, or who were awarded a badge
       * here (to see it in My badges), can create an account (decision 53).
       */
      validateUserInfo: async ({ user: incoming, source }) => {
        if (config.signupMode !== 'invite' || source.action !== 'create-user') return;
        const email = typeof incoming.email === 'string' ? incoming.email : '';
        if (!(await mayCreateAccountByInvitation(db, email))) {
          return {
            error: 'signup_closed',
            errorDescription:
              'This credforge instance only accepts new accounts from people who were invited or awarded a badge here.',
          };
        }
      },
    },
    session: {
      additionalFields: {
        mfaVerifiedAt: { type: 'date', required: false, input: false },
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        // No silent merging: an existing account connects Google or Microsoft from Settings.
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
    },

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user: target, token }) => {
        const url = `${publicBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
        background(
          outbox.send(resetPasswordMessage(target.email, target.name, url)),
          'password reset email',
        );
      },
      onPasswordReset: async ({ user: target }, request) => {
        const headers = request?.headers;
        await auditUser(target, 'user.password_reset', { headers });
      },
      // Sign-up with an address that already has an account looks like a normal sign-up to the
      // caller (no account enumeration); the owner of the address gets this email instead.
      onExistingUserSignUp: async ({ user: existing }) => {
        background(
          outbox.send(
            existingAccountMessage(existing.email, existing.name, `${publicBaseUrl}/login`),
          ),
          'existing account email',
        );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 24 * 60 * 60,
      sendVerificationEmail: async ({ user: target, token }) => {
        // Always land on the app's confirmation screen, whichever flow sent the email.
        const url = `${publicBaseUrl}${AUTH_BASE_PATH}/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent('/verify-email')}`;
        background(
          outbox.send(verifyEmailMessage(target.email, target.name, url)),
          'verification email',
        );
      },
    },
    socialProviders,

    databaseHooks: {
      account: {
        create: {
          before: async (data) => ({ data: stripProviderTokens(data) }),
          after: (created, ctx) =>
            auditAccountOwner(created, 'user.sign_in_method_added', ctx as HookContext),
        },
        update: { before: async (data) => ({ data: stripProviderTokens(data) }) },
        delete: {
          after: (deleted, ctx) =>
            auditAccountOwner(deleted, 'user.sign_in_method_removed', ctx as HookContext),
        },
      },
      user: {
        create: {
          after: async (created, ctx) => {
            await auditUser(created, 'user.created', ctx as HookContext, {
              method: signInMethod(ctx as HookContext),
            });
          },
        },
      },
      session: {
        create: {
          after: async (created, ctx) => {
            const hook = ctx as HookContext | null;
            // A replacement for an existing session (enabling or disabling 2FA), not a sign-in.
            if (hook?.context?.session) return;
            const [owner] = await db
              .select({ id: user.id, email: user.email, twoFactorEnabled: user.twoFactorEnabled })
              .from(user)
              .where(eq(user.id, created.userId as string));
            if (!owner) return;
            // Password sign-in with two-step verification on: this session is discarded until the
            // code is entered, and that creates the real one.
            if (hook?.path === '/sign-in/email' && owner.twoFactorEnabled) return;
            await auditUser(owner, 'user.signed_in', hook, { method: signInMethod(hook) });
          },
        },
      },
    },

    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const hook = ctx as unknown as HookContext & { context: { returned?: unknown } };
        const returned = hook.context.returned;
        if (isAPIError(returned) && Number(returned.statusCode) >= 400) return;
        const current = hook.context.session;
        const created = hook.context.newSession;

        switch (hook.path) {
          case '/two-factor/verify-totp':
          case '/two-factor/verify-backup-code': {
            // This session (new or existing) has now passed the second factor.
            const token = created?.session.token ?? current?.session.token;
            if (token) {
              await db
                .update(session)
                .set({ mfaVerifiedAt: new Date() })
                .where(eq(session.token, token));
            }
            if (current && !current.user.twoFactorEnabled) {
              await auditUser(current.user, 'user.two_factor_enabled', hook);
            } else if (current) {
              await auditUser(current.user, 'session.second_factor_passed', hook);
            }
            return;
          }
          case '/two-factor/disable':
            if (current) await auditUser(current.user, 'user.two_factor_disabled', hook);
            return;
          case '/two-factor/generate-backup-codes':
            if (current) await auditUser(current.user, 'user.backup_codes_regenerated', hook);
            return;
          case '/change-password':
            if (current) await auditUser(current.user, 'user.password_changed', hook);
            return;
          case '/update-user':
            if (current) {
              await auditUser(current.user, 'user.updated', hook, {
                fields: Object.keys((hook.body ?? {}) as object),
              });
            }
            return;
          case '/verify-email':
            if (created) await auditUser(created.user, 'user.email_verified', hook);
            return;
        }
      }),
    },

    plugins: [
      twoFactor({
        issuer: 'credforge',
        // Accounts with only Google or Microsoft have no password to confirm with; those with a
        // password must still enter it.
        allowPasswordless: true,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
