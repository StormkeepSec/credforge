import { account, eq, session, user } from '@credforge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expectProblem,
  lastEmailTo,
  linkIn,
  newUser,
  TestClient,
  verificationLink,
} from './support/client';
import { createTestEnvironment, type TestEnvironment } from './support/harness';
import { googleClaims, microsoftClaims, OAUTH_ENV, oauthSignIn } from './support/oauth';

let env: TestEnvironment;
beforeAll(async () => {
  env = await createTestEnvironment({ ...OAUTH_ENV, REQUIRE_MFA_FOR_ADMINS: 'true' });
});
afterAll(async () => {
  await env?.close();
});

/** A user who owns an org and has two-step verification on. */
async function owner(email?: string) {
  const client = await newUser(env, { email });
  const created = await client.post('/api/v1/orgs', { name: `Org of ${client.email}` });
  expect(created.statusCode).toBe(201);
  return { client, orgId: (created.json() as { id: string }).id };
}

async function accountsOf(email: string) {
  return env.ownerDb
    .select({
      providerId: account.providerId,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      idToken: account.idToken,
    })
    .from(account)
    .innerJoin(user, eq(account.userId, user.id))
    .where(eq(user.email, email));
}

describe('email and password', () => {
  it('requires a verified email before signing in', async () => {
    const client = new TestClient(env, 'unverified@example.org', 'correct horse battery');
    const signUp = await client.post('/api/auth/sign-up/email', {
      name: 'Unverified',
      email: client.email,
      password: client.password,
    });
    expect(signUp.statusCode).toBe(200);
    expect(client.cookies.size).toBe(0);

    const signIn = await client.post('/api/auth/sign-in/email', {
      email: client.email,
      password: client.password,
    });
    expect(signIn.statusCode).toBe(403);
    expect((await client.get('/api/v1/me')).statusCode).toBe(401);

    // Following the link from the email confirms the address and signs in.
    const link = new URL(verificationLink(env, client.email));
    expect(link.searchParams.get('callbackURL')).toBe('/verify-email');
    const verified = await client.get(link.pathname + link.search);
    expect(verified.statusCode).toBe(302);
    expect(verified.headers.location).toBe('/verify-email');
    const me = await client.me();
    expect(me.user).toMatchObject({ email: client.email, emailVerified: true });
    expect(me.mfa).toEqual({ state: 'ok', required: false });
  });

  it('rejects short passwords', async () => {
    const client = new TestClient(env, 'short@example.org', 'short');
    const response = await client.post('/api/auth/sign-up/email', {
      name: 'Short',
      email: client.email,
      password: 'too-short',
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers a sign-up for an existing address like a new one and emails the owner', async () => {
    const existing = await newUser(env, { twoFactor: false });
    const again = new TestClient(env, existing.email, 'another long password');
    const response = await again.post('/api/auth/sign-up/email', {
      name: 'Someone',
      email: existing.email,
      password: again.password,
    });
    expect(response.statusCode).toBe(200);
    expect(lastEmailTo(env, existing.email).kind).toBe('existing-account');
  });

  it('resets a forgotten password with the emailed link and ends other sessions', async () => {
    const client = await newUser(env, { twoFactor: false });
    const requested = await client.post('/api/auth/request-password-reset', {
      email: client.email,
    });
    expect(requested.statusCode).toBe(200);
    const link = linkIn(
      lastEmailTo(env, client.email, 'reset-password').text,
      /https:\/\/\S+reset-password\?token=\S+/,
    );
    const token = new URL(link).searchParams.get('token');

    const reset = await new TestClient(env, client.email, '').post('/api/auth/reset-password', {
      token,
      newPassword: 'a brand new password',
    });
    expect(reset.statusCode).toBe(200);
    expect((await client.get('/api/v1/me')).statusCode).toBe(401);
    await new TestClient(env, client.email, 'a brand new password').signIn();
  });
});

describe('two-step verification', () => {
  it('asks for a code after the password, and marks that session verified', async () => {
    const { client } = await owner();
    const fresh = new TestClient(env, client.email, client.password);
    fresh.totpSecret = client.totpSecret;

    const signIn = await fresh.post('/api/auth/sign-in/email', {
      email: fresh.email,
      password: fresh.password,
    });
    expect(signIn.json()).toMatchObject({ twoFactorRedirect: true });
    expect((await fresh.get('/api/v1/me')).statusCode).toBe(401);

    await fresh.verifyTotp();
    const me = await fresh.me();
    expect(me.mfa).toEqual({ state: 'ok', required: true });
    expect(me.memberships).toHaveLength(1);
  });

  it('rejects a wrong code', async () => {
    const { client } = await owner();
    const fresh = new TestClient(env, client.email, client.password);
    await fresh.post('/api/auth/sign-in/email', { email: fresh.email, password: fresh.password });
    const wrong = await fresh.post('/api/auth/two-factor/verify-totp', { code: '000000' });
    expect(wrong.statusCode).toBe(401);
    expect((await fresh.get('/api/v1/me')).statusCode).toBe(401);
  });

  it('makes a new owner set up two-step verification before anything else', async () => {
    const client = await newUser(env, { twoFactor: false });
    const created = await client.post('/api/v1/orgs', { name: 'Needs MFA' });
    expect(created.statusCode).toBe(201);
    const orgId = (created.json() as { id: string }).id;

    expect((await client.me()).mfa).toEqual({ state: 'setup', required: true });
    expectProblem(await client.get(`/api/v1/orgs/${orgId}`), 403, 'mfa_setup_required');
    expectProblem(
      await client.post('/api/v1/orgs', { name: 'Another' }),
      403,
      'mfa_setup_required',
    );
    // Sensitive auth endpoints wait too.
    expect(
      (
        await client.post('/api/auth/change-password', {
          currentPassword: client.password,
          newPassword: 'something else entirely',
        })
      ).statusCode,
    ).toBe(403);

    await client.enableTwoFactor();
    expect((await client.me()).mfa).toEqual({ state: 'ok', required: true });
    expect((await client.get(`/api/v1/orgs/${orgId}`)).statusCode).toBe(200);
  });

  it('does not require it of issuers and viewers', async () => {
    const { client: ownerClient, orgId } = await owner();
    const viewer = await newUser(env, { twoFactor: false });
    await ownerClient.post(`/api/v1/orgs/${orgId}/invitations`, {
      email: viewer.email,
      role: 'viewer',
    });
    const token = linkIn(lastEmailTo(env, viewer.email, 'invitation').text, /\/invite\/\S+/)
      .split('/')
      .pop();
    expect((await viewer.post(`/api/v1/invitations/${token}/accept`)).statusCode).toBe(200);
    expect((await viewer.me()).mfa).toEqual({ state: 'ok', required: false });
    expect((await viewer.get(`/api/v1/orgs/${orgId}`)).statusCode).toBe(200);
  });

  it('requires it of platform admins', async () => {
    const admin = await newUser(env, { twoFactor: false, platformAdmin: true });
    expect((await admin.me()).mfa).toEqual({ state: 'setup', required: true });
    expectProblem(await admin.get('/api/v1/platform/orgs'), 403, 'mfa_setup_required');
  });
});

describe('Continue with Google', () => {
  it('creates a verified account and stores no provider tokens', async () => {
    const client = new TestClient(env, 'google-new@example.org', '');
    const callback = await oauthSignIn(client, 'google', googleClaims(client.email));
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/app');

    const me = await client.me();
    expect(me.user).toMatchObject({ email: client.email, emailVerified: true });
    expect(await accountsOf(client.email)).toEqual([
      { providerId: 'google', accessToken: null, refreshToken: null, idToken: null },
    ]);
  });

  it("doesn't merge into an existing password account", async () => {
    const existing = await newUser(env, { twoFactor: false });
    const stranger = new TestClient(env, existing.email, '');
    const callback = await oauthSignIn(stranger, 'google', googleClaims(existing.email));
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('error=account_not_linked');
    expect((await stranger.get('/api/v1/me')).statusCode).toBe(401);
    expect((await accountsOf(existing.email)).map((row) => row.providerId)).toEqual(['credential']);
  });

  it('connects explicitly from a signed-in session, without tokens', async () => {
    const client = await newUser(env, { twoFactor: false });
    const linked = await oauthSignIn(client, 'google', googleClaims(client.email), { link: true });
    expect(linked.statusCode).toBe(302);
    expect(linked.headers.location).toBe('/app/settings');
    expect((await accountsOf(client.email)).map((row) => row.providerId).sort()).toEqual([
      'credential',
      'google',
    ]);
    expect(
      (await accountsOf(client.email)).every(
        (row) => row.accessToken === null && row.refreshToken === null,
      ),
    ).toBe(true);

    // Now Google signs in to the same account.
    const viaGoogle = new TestClient(env, client.email, '');
    await oauthSignIn(viaGoogle, 'google', googleClaims(client.email));
    expect((await viaGoogle.me()).user.email).toBe(client.email);
  });

  it('still asks owners for their credforge second factor', async () => {
    const { client, orgId } = await owner();
    await oauthSignIn(client, 'google', googleClaims(client.email), { link: true });

    const viaGoogle = new TestClient(env, client.email, '');
    viaGoogle.totpSecret = client.totpSecret;
    const callback = await oauthSignIn(viaGoogle, 'google', googleClaims(client.email));
    expect(callback.headers.location).toBe('/app');

    const me = await viaGoogle.me();
    expect(me.mfa).toEqual({ state: 'challenge', required: true });
    expect(me.memberships).toEqual([]);
    expectProblem(await viaGoogle.get(`/api/v1/orgs/${orgId}`), 403, 'mfa_required');
    // Nothing that could weaken the account works before the code is entered.
    for (const path of [
      '/api/auth/two-factor/disable',
      '/api/auth/two-factor/get-totp-uri',
      '/api/auth/list-accounts',
      '/api/auth/unlink-account',
      '/api/auth/link-social',
    ]) {
      const method = path === '/api/auth/list-accounts' ? 'GET' : 'POST';
      const response = await viaGoogle.request(
        method,
        path,
        method === 'POST' ? { providerId: 'credential', provider: 'google' } : undefined,
      );
      expect(response.statusCode, path).toBe(403);
      expect(response.json(), path).toMatchObject({ code: 'MFA_REQUIRED' });
    }
    const [row] = await env.ownerDb.select().from(user).where(eq(user.email, client.email));
    expect(row?.twoFactorEnabled).toBe(true);

    await viaGoogle.verifyTotp();
    expect((await viaGoogle.me()).mfa.state).toBe('ok');
    expect((await viaGoogle.get(`/api/v1/orgs/${orgId}`)).statusCode).toBe(200);
  });

  it('asks a voluntary 2FA user for the code too', async () => {
    const client = await newUser(env); // not an owner, but turned 2FA on
    await oauthSignIn(client, 'google', googleClaims(client.email), { link: true });
    const viaGoogle = new TestClient(env, client.email, '');
    await oauthSignIn(viaGoogle, 'google', googleClaims(client.email));
    expect((await viaGoogle.me()).mfa).toEqual({ state: 'challenge', required: false });
    expectProblem(await viaGoogle.post('/api/v1/orgs', { name: 'x' }), 403, 'mfa_required');
  });

  it('lets a Google-only owner set up two-step verification without a password', async () => {
    const client = new TestClient(env, 'google-owner@example.org', '');
    await oauthSignIn(client, 'google', googleClaims(client.email));
    const created = await client.post('/api/v1/orgs', { name: 'Google-only org' });
    expect(created.statusCode).toBe(201);
    expect((await client.me()).mfa.state).toBe('setup');
    await client.enableTwoFactor();
    expect((await client.me()).mfa.state).toBe('ok');
    const [row] = await env.ownerDb
      .select({ mfaVerifiedAt: session.mfaVerifiedAt })
      .from(session)
      .innerJoin(user, eq(session.userId, user.id))
      .where(eq(user.email, client.email));
    expect(row?.mfaVerifiedAt).toBeInstanceOf(Date);
  });
});

describe('Continue with Microsoft', () => {
  it('trusts the email only when xms_edov is true', async () => {
    const trusted = new TestClient(env, 'ms-trusted@example.org', '');
    await oauthSignIn(trusted, 'microsoft', microsoftClaims(trusted.email, { xms_edov: true }));
    expect((await trusted.me()).user).toMatchObject({ emailVerified: true });
  });

  it('sends its own verification email when xms_edov is missing', async () => {
    const client = new TestClient(env, 'ms-unverified@example.org', '');
    const callback = await oauthSignIn(client, 'microsoft', microsoftClaims(client.email));
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('error=email_not_verified');
    expect((await client.get('/api/v1/me')).statusCode).toBe(401);
    const [row] = await env.ownerDb.select().from(user).where(eq(user.email, client.email));
    expect(row?.emailVerified).toBe(false);

    // Confirming the address signs in; Microsoft sign-in works from then on.
    const link = new URL(verificationLink(env, client.email));
    await client.get(link.pathname + link.search);
    expect((await client.me()).user.emailVerified).toBe(true);
  });

  it('treats xms_edov=false as unverified', async () => {
    const client = new TestClient(env, 'ms-false@example.org', '');
    const callback = await oauthSignIn(
      client,
      'microsoft',
      microsoftClaims(client.email, { xms_edov: false }),
    );
    expect(callback.headers.location).toContain('error=email_not_verified');
  });
});
