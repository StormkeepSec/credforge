import { createAuthClient } from 'better-auth/client';
import { twoFactorClient } from 'better-auth/client/plugins';

/**
 * Better Auth's client for sign-in, sign-up, email verification, password reset, sign-in
 * methods and TOTP. Everything else in the app goes through `/api/v1` (see api.ts).
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
  plugins: [twoFactorClient()],
});

export type SocialProvider = 'google' | 'microsoft';

export const PROVIDER_LABELS: Record<SocialProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
};

/** Better Auth error codes → what the person should do next. */
const AUTH_ERRORS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'That email and password don’t match.',
  EMAIL_NOT_VERIFIED: 'Confirm your email address first. We sent you a new link.',
  INVALID_CODE: 'That code didn’t work. Check the time on your phone and try again.',
  INVALID_BACKUP_CODE: 'That backup code didn’t work.',
  INVALID_TWO_FACTOR_COOKIE: 'Your sign-in expired. Sign in again.',
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: 'Too many attempts. Sign in again.',
  ACCOUNT_TEMPORARILY_LOCKED: 'Too many wrong codes. Try again in 15 minutes.',
  INVALID_PASSWORD: 'That password isn’t right.',
  PASSWORD_TOO_SHORT: 'Use at least 10 characters.',
  PASSWORD_TOO_LONG: 'Use at most 128 characters.',
  INVALID_TOKEN: 'This link is invalid or has expired. Ask for a new one.',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'This account has no password yet.',
  FAILED_TO_UNLINK_LAST_ACCOUNT: 'Keep at least one way to sign in.',
  MFA_REQUIRED: 'Enter a code from your authenticator app first.',
  MFA_SETUP_REQUIRED: 'Turn on two-step verification first.',
};

/** Errors that come back to /login from Google or Microsoft (`?error=`). */
const OAUTH_ERRORS: Record<string, string> = {
  account_not_linked:
    'You already have a credforge account with this email address. Sign in the usual way, then connect it under Settings → Sign-in methods.',
  email_not_verified:
    'Check your inbox: we sent a link to confirm the email address on that account. Then sign in again.',
  signup_closed: 'This credforge site only accepts new accounts by invitation.',
  access_denied: 'Sign-in was cancelled.',
};

export function authErrorMessage(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return 'Something went wrong. Try again.';
  return (
    (error.code && AUTH_ERRORS[error.code]) || error.message || 'Something went wrong. Try again.'
  );
}

export function oauthErrorMessage(code: string): string {
  return OAUTH_ERRORS[code] ?? 'Sign-in didn’t work. Try again, or use another sign-in method.';
}
