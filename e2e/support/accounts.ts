import type { APIRequestContext, APIResponse } from '@playwright/test';
import { LINKS, mailLink } from './mailpit';
import { BASE_URL, runPnpm } from './stack';
import { secretFromUri, totp } from './totp';

// Seeds accounts through Better Auth and the credforge API, the same endpoints the app calls.
// Each helper acts with the cookies of the request context it's given, so a page's
// `page.request` signs that page in.

/** The API checks `Origin` on state-changing requests, like a browser would send it. */
const headers = { origin: BASE_URL };

async function ok(response: APIResponse, what: string): Promise<APIResponse> {
  if (!response.ok()) {
    throw new Error(`${what} failed: ${response.status()} ${await response.text()}`);
  }
  return response;
}

export async function post<T = unknown>(
  request: APIRequestContext,
  path: string,
  data: unknown = {},
): Promise<T> {
  const response = await ok(await request.post(path, { data, headers }), `POST ${path}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface Account {
  name: string;
  email: string;
  password: string;
}

/** Creates an account and confirms its email from the Mailpit link, which signs it in. */
export async function signUpAndConfirm(request: APIRequestContext, account: Account) {
  await post(request, '/api/auth/sign-up/email', { ...account, callbackURL: '/verify-email' });
  const link = await mailLink(account.email, LINKS.verifyEmail);
  await ok(await request.get(link), 'Opening the confirmation link');
}

export async function signIn(
  request: APIRequestContext,
  account: Pick<Account, 'email' | 'password'>,
) {
  return post<{ twoFactorRedirect?: boolean }>(request, '/api/auth/sign-in/email', {
    email: account.email,
    password: account.password,
  });
}

/** Turns on two-step verification for the signed-in account; returns the TOTP secret. */
export async function enableTwoFactor(request: APIRequestContext, password: string) {
  const { totpURI } = await post<{ totpURI: string }>(request, '/api/auth/two-factor/enable', {
    password,
  });
  const secret = secretFromUri(totpURI);
  await post(request, '/api/auth/two-factor/verify-totp', { code: totp(secret) });
  return secret;
}

/** Promotes an existing account with the server's CLI, as an operator would. */
export async function makePlatformAdmin(email: string) {
  await runPnpm([
    '--filter',
    '@credforge/server',
    'cli',
    'create-platform-admin',
    '--email',
    email,
  ]);
}

export async function me(request: APIRequestContext) {
  const response = await ok(await request.get('/api/v1/me'), 'GET /api/v1/me');
  return (await response.json()) as { mfa: { state: string }; user: { email: string } };
}
