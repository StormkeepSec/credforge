/**
 * Microsoft's `email` claim is not verified for multi-tenant apps: anyone who runs an Entra
 * tenant can put any address in it (the "nOAuth" takeover). credforge trusts it only when the
 * optional `xms_edov` claim (email domain owner verified) is true. Otherwise credforge sends its
 * own verification email before the account can be used (design plan §6.4).
 */
export function isMicrosoftEmailVerified(claims: Record<string, unknown>): boolean {
  const value = claims.xms_edov;
  return value === true || value === 1 || value === 'true' || value === '1';
}

/** Account fields that hold provider tokens. credforge only needs to know who signed in. */
const TOKEN_FIELDS = [
  'accessToken',
  'refreshToken',
  'idToken',
  'accessTokenExpiresAt',
  'refreshTokenExpiresAt',
] as const;

/**
 * Removes provider access, refresh and id tokens from an account row before it is saved, so
 * nothing can act on the user's Google or Microsoft account later (§6.4).
 */
export function stripProviderTokens<T extends Record<string, unknown>>(account: T): T {
  const copy: Record<string, unknown> = { ...account };
  for (const field of TOKEN_FIELDS) {
    if (field in copy) copy[field] = null;
  }
  return copy as T;
}
