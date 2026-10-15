import type { MfaState } from '@credforge/contracts';
import { PRIVILEGED_ROLES } from '@credforge/contracts';
import { and, type Database, eq, inArray, member } from '@credforge/db';

/**
 * The credforge second-factor gate (design plan §6.4).
 *
 * Better Auth only enforces two-step verification on password sign-in; Google and Microsoft
 * sign-ins skip it. credforge decides per session instead: each session records when it passed
 * a TOTP or backup code (`session.mfa_verified_at`), whichever way it was started.
 *
 * - A user who has two-step verification on must pass it in every session (`challenge`).
 * - When REQUIRE_MFA_FOR_ADMINS=true, owners, admins and platform admins must turn it on before
 *   doing anything else (`setup`).
 */
export function mfaState(input: {
  /** The user must use a second factor (privileged and REQUIRE_MFA_FOR_ADMINS=true). */
  required: boolean;
  twoFactorEnabled: boolean;
  /** This session passed a second factor. */
  sessionVerified: boolean;
}): MfaState {
  if (input.twoFactorEnabled) return input.sessionVerified ? 'ok' : 'challenge';
  return input.required ? 'setup' : 'ok';
}

/** Whether the user is an owner or admin of any organization. */
export async function hasPrivilegedRole(db: Database, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, userId), inArray(member.role, [...PRIVILEGED_ROLES])))
    .limit(1);
  return rows.length > 0;
}

/**
 * Better Auth endpoints (paths under /api/auth) a session may use while its MFA state isn't `ok`.
 * Everything else, including linking or unlinking sign-in methods, changing the password and
 * turning two-step verification off, waits until the session has passed the second factor.
 */
const ALWAYS_ALLOWED = new Set([
  '/get-session',
  '/sign-out',
  '/ok',
  '/error',
  // Starting a new sign-in replaces the session; these don't act on the current one.
  '/sign-in/email',
  '/sign-in/social',
  '/sign-up/email',
  '/verify-email',
  '/send-verification-email',
  '/request-password-reset',
  '/reset-password',
  // The second factor itself.
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
]);

/** Also allowed while setting up two-step verification for the first time. */
const ALLOWED_DURING_SETUP = new Set(['/two-factor/enable', '/two-factor/get-totp-uri']);

export function isAuthPathAllowed(path: string, state: MfaState): boolean {
  if (state === 'ok') return true;
  if (ALWAYS_ALLOWED.has(path)) return true;
  // OAuth callbacks and the reset-password link (`/reset-password/{token}`) carry their own proof.
  if (path.startsWith('/callback/') || path.startsWith('/reset-password/')) return true;
  return state === 'setup' && ALLOWED_DURING_SETUP.has(path);
}
