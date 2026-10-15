import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import type { TestClient } from './client';

export type Provider = 'google' | 'microsoft';

const TOKEN_ENDPOINTS: Record<Provider, string> = {
  google: 'https://oauth2.googleapis.com/token',
  microsoft: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
};

/** Client settings for the test providers (the token endpoint is stubbed, see below). */
export const OAUTH_ENV = {
  GOOGLE_CLIENT_ID: 'test-google-client',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  MICROSOFT_CLIENT_ID: 'test-microsoft-client',
  MICROSOFT_CLIENT_SECRET: 'test-microsoft-secret',
};

function base64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** An unsigned JWT: Better Auth decodes (doesn't verify) id tokens from the token endpoint. */
function idToken(claims: Record<string, unknown>) {
  return `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url(claims)}.c2lnbmF0dXJl`;
}

export function googleClaims(email: string, extra: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: OAUTH_ENV.GOOGLE_CLIENT_ID,
    sub: `google-${email}`,
    email,
    email_verified: true,
    name: `Google ${email}`,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  };
}

export function microsoftClaims(email: string, extra: Record<string, unknown> = {}) {
  const tid = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  return {
    iss: `https://login.microsoftonline.com/${tid}/v2.0`,
    aud: OAUTH_ENV.MICROSOFT_CLIENT_ID,
    tid,
    oid: `oid-${randomBytes(4).toString('hex')}-${email}`,
    sub: `ms-${email}`,
    email,
    name: `Microsoft ${email}`,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  };
}

/**
 * Answers the provider's token endpoint with tokens for `claims`. Everything else Better Auth does
 * for real: the state and PKCE round trip, the callback, account linking rules and the hooks.
 */
function stubTokenEndpoint(provider: Provider, claims: Record<string, unknown>) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(TOKEN_ENDPOINTS[provider])) {
      return new Response(
        JSON.stringify({
          access_token: 'provider-access-token',
          refresh_token: 'provider-refresh-token',
          id_token: idToken(claims),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email profile',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch(input, init);
  });
}

/**
 * "Continue with Google/Microsoft": starts the sign-in (or, with `link`, connects the provider to
 * the signed-in account), then returns the provider's redirect back to the callback.
 */
export async function oauthSignIn(
  client: TestClient,
  provider: Provider,
  claims: Record<string, unknown>,
  { link = false }: { link?: boolean } = {},
) {
  const start = link
    ? await client.post('/api/auth/link-social', { provider, callbackURL: '/app/settings' })
    : await client.post('/api/auth/sign-in/social', {
        provider,
        callbackURL: '/app',
        errorCallbackURL: '/login',
      });
  if (start.statusCode !== 200) return start;
  const { url } = start.json() as { url: string };
  const state = new URL(url).searchParams.get('state');
  if (!state) throw new Error(`No state in ${url}`);
  stubTokenEndpoint(provider, claims);
  try {
    return await client.get(
      `/api/auth/callback/${provider}?code=test-code&state=${encodeURIComponent(state)}`,
    );
  } finally {
    vi.unstubAllGlobals();
  }
}
