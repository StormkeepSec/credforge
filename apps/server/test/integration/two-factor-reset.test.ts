import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { and, auditEvent, eq, session, twoFactor, user } from '@credforge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeTwoFactorReset, resetTwoFactor } from '../../src/auth/two-factor-reset';
import { base32Decode, expectProblem, newUser, TestClient, totp } from './support/client';
import { createTestEnvironment, type TestEnvironment } from './support/harness';

let env: TestEnvironment;
beforeAll(async () => {
  env = await createTestEnvironment({ REQUIRE_MFA_FOR_ADMINS: 'true' });
});
afterAll(async () => {
  await env?.close();
});

const CLI_ACTOR = { type: 'system' as const, label: 'cli' };

function reset(email: string) {
  return resetTwoFactor(env.db, {
    email,
    requireMfaForAdmins: env.config.requireMfaForAdmins,
    actor: CLI_ACTOR,
  });
}

/** A user who owns an org and has two-step verification on. */
async function owner() {
  const client = await newUser(env);
  const created = await client.post('/api/v1/orgs', { name: `Org of ${client.email}` });
  expect(created.statusCode).toBe(201);
  return { client, orgId: (created.json() as { id: string }).id };
}

async function userRow(email: string) {
  const [row] = await env.ownerDb.select().from(user).where(eq(user.email, email));
  if (!row) throw new Error(`No user ${email}`);
  return row;
}

async function sessionCount(userId: string) {
  return (await env.ownerDb.select().from(session).where(eq(session.userId, userId))).length;
}

async function resetEvents(userId: string) {
  return env.ownerDb
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.action, 'user.two_factor_reset'), eq(auditEvent.targetId, userId)));
}

/** A 6-digit code that none of the codes the server accepts right now can equal. */
function wrongCode(secret: Buffer) {
  const valid = [-1, 0, 1].map((step) => totp(secret, Date.now() + step * 30_000));
  return ['000000', '111111', '222222', '333333'].find((code) => !valid.includes(code)) ?? '';
}

/** Signs in with the password and answers the code prompt wrongly `count` times. */
async function failCodes(client: TestClient, count: number) {
  const signIn = await client.post('/api/auth/sign-in/email', {
    email: client.email,
    password: client.password,
  });
  expect(signIn.json()).toMatchObject({ twoFactorRedirect: true });
  for (let attempt = 0; attempt < count; attempt++) {
    const wrong = await client.post('/api/auth/two-factor/verify-totp', {
      code: wrongCode(client.totpSecret ?? Buffer.alloc(0)),
    });
    expect(wrong.statusCode).toBe(401);
  }
}

/** A new browser for the same person, holding the same authenticator. */
function sameUser(client: TestClient) {
  const other = new TestClient(env, client.email, client.password);
  other.totpSecret = client.totpSecret;
  return other;
}

describe('the authenticator entry', () => {
  function expectNamedEntry(totpURI: string, email: string) {
    const label = `credforge%20(credforge.test):${encodeURIComponent(email)}`;
    expect(totpURI.startsWith(`otpauth://totp/${label}?`)).toBe(true);
    expect(totpURI).toContain('&issuer=credforge%20(credforge.test)&');
    expect(totpURI).not.toContain('+');
    expect(new URL(totpURI).searchParams.get('issuer')).toBe('credforge (credforge.test)');
  }

  it('is named after the instance, with the space percent-encoded', async () => {
    const client = await newUser(env, { twoFactor: false });
    const enabled = await client.post('/api/auth/two-factor/enable', { password: client.password });
    expect(enabled.statusCode).toBe(200);
    expectNamedEntry((enabled.json() as { totpURI: string }).totpURI, client.email);

    // A client can't name it something else (Better Auth's enable takes an issuer from the body).
    const renamed = await client.post('/api/auth/two-factor/enable', {
      password: client.password,
      issuer: 'credforge',
    });
    expectNamedEntry((renamed.json() as { totpURI: string }).totpURI, client.email);

    // Showing it again later (get-totp-uri, which ignores Better Auth's issuer setting) gives the
    // same name and the enrolled secret.
    await client.enableTwoFactor();
    const again = await client.post('/api/auth/two-factor/get-totp-uri', {
      password: client.password,
    });
    expect(again.statusCode).toBe(200);
    const shown = (again.json() as { totpURI: string }).totpURI;
    expectNamedEntry(shown, client.email);
    const secret = base32Decode(new URL(shown).searchParams.get('secret') ?? '');
    expect(client.totpSecret && secret.equals(client.totpSecret)).toBe(true);
  });
});

describe('reset-two-factor', () => {
  it('lets a locked-out owner back in, and makes them set it up again first', async () => {
    const { client, orgId } = await owner();
    await sameUser(client).signIn(); // a second browser
    const account = await userRow(client.email);
    const sessionsBefore = await sessionCount(account.id);
    expect(sessionsBefore).toBeGreaterThanOrEqual(2);

    // Ten wrong codes over two sign-ins (five each is the most one sign-in allows) lock it.
    const attacker = sameUser(client);
    await failCodes(attacker, 5);
    await failCodes(attacker, 5);
    const locked = sameUser(client);
    await locked.post('/api/auth/sign-in/email', {
      email: locked.email,
      password: locked.password,
    });
    const refused = await locked.post('/api/auth/two-factor/verify-totp', {
      code: totp(client.totpSecret ?? Buffer.alloc(0)),
    });
    expect(refused.statusCode).toBe(429);
    const [before] = await env.ownerDb
      .select()
      .from(twoFactor)
      .where(eq(twoFactor.userId, account.id));
    expect(before?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());

    const result = await reset(client.email);
    expect(result).toEqual({
      outcome: 'reset',
      userId: account.id,
      sessionsEnded: sessionsBefore,
      wasLocked: true,
      setupRequired: true,
    });
    expect(describeTwoFactorReset(client.email, result)).toContain(
      'at their next sign-in they must set it up again',
    );

    // Secret, backup codes and lockout gone; the flag off; every session ended.
    expect(
      await env.ownerDb.select().from(twoFactor).where(eq(twoFactor.userId, account.id)),
    ).toEqual([]);
    expect((await userRow(client.email)).twoFactorEnabled).toBe(false);
    expect(await sessionCount(account.id)).toBe(0);
    expect((await client.get('/api/v1/me')).statusCode).toBe(401);

    // Audited as the operator, with nothing secret in it.
    const events = await resetEvents(account.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      orgId: null,
      actorType: 'system',
      actorId: null,
      actorLabel: 'cli',
      targetType: 'user',
      ip: null,
      userAgent: null,
    });
    expect(events[0]?.data).toEqual({
      email: client.email,
      sessionsEnded: sessionsBefore,
      wasLocked: true,
    });

    // The next sign-in asks for no code, and leads straight to setting it up again.
    const next = new TestClient(env, client.email, client.password);
    const signIn = await next.post('/api/auth/sign-in/email', {
      email: next.email,
      password: next.password,
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json()).not.toHaveProperty('twoFactorRedirect');
    expect((await next.me()).mfa).toEqual({ state: 'setup', required: true });
    expectProblem(await next.get(`/api/v1/orgs/${orgId}`), 403, 'mfa_setup_required');

    await next.enableTwoFactor();
    expect(next.totpSecret?.equals(client.totpSecret ?? Buffer.alloc(0))).toBe(false);
    expect((await next.me()).mfa).toEqual({ state: 'ok', required: true });
    expect((await next.get(`/api/v1/orgs/${orgId}`)).statusCode).toBe(200);

    // The old authenticator entry no longer works.
    const old = sameUser(client);
    await old.post('/api/auth/sign-in/email', { email: old.email, password: old.password });
    const oldCode = await old.post('/api/auth/two-factor/verify-totp', {
      code: totp(client.totpSecret ?? Buffer.alloc(0)),
    });
    expect(oldCode.statusCode).toBe(401);
  });

  it('makes a platform admin set it up again too', async () => {
    const admin = await newUser(env, { platformAdmin: true });
    const result = await reset(admin.email);
    expect(result).toMatchObject({ outcome: 'reset', wasLocked: false, setupRequired: true });

    const next = await new TestClient(env, admin.email, admin.password).signIn();
    expect((await next.me()).mfa).toEqual({ state: 'setup', required: true });
    expectProblem(await next.get('/api/v1/platform/orgs'), 403, 'mfa_setup_required');
  });

  it('lets someone who chose it themselves sign in without a code', async () => {
    const member = await newUser(env);
    const result = await reset(member.email);
    expect(result).toMatchObject({ outcome: 'reset', setupRequired: false });
    expect(describeTwoFactorReset(member.email, result)).toContain(
      'can turn two-step verification on again in Account settings',
    );

    const next = new TestClient(env, member.email, member.password);
    const signIn = await next.post('/api/auth/sign-in/email', {
      email: next.email,
      password: next.password,
    });
    expect(signIn.json()).not.toHaveProperty('twoFactorRedirect');
    expect((await next.me()).mfa).toEqual({ state: 'ok', required: false });
  });

  it('refuses an address with no account, changing nothing', async () => {
    const before = await env.ownerDb.select().from(auditEvent);
    expect(await reset('nobody@example.org')).toEqual({ outcome: 'no_account' });
    expect(await env.ownerDb.select().from(auditEvent)).toHaveLength(before.length);
  });

  it("says so when it isn't on, and leaves the account alone", async () => {
    const client = await newUser(env, { twoFactor: false });
    const account = await userRow(client.email);
    expect(await reset(client.email)).toEqual({ outcome: 'not_on' });

    // A setup that was started but never confirmed with a code isn't "on" either.
    const started = await client.post('/api/auth/two-factor/enable', { password: client.password });
    expect(started.statusCode).toBe(200);
    expect(await reset(client.email)).toEqual({ outcome: 'not_on' });

    expect(await resetEvents(account.id)).toEqual([]);
    expect((await client.get('/api/v1/me')).statusCode).toBe(200);
  });
});

describe('cli.js reset-two-factor', () => {
  const SERVER_DIR = resolve(import.meta.dirname, '../..');

  /** Runs the real command (`src/cli.ts` through tsx) against this test's database. */
  async function cli(...args: string[]) {
    try {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', ...args],
        { cwd: SERVER_DIR, env: { ...process.env, ...env.processEnv } },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  }

  it('resets, explains what happens next, and refuses unknown addresses', async () => {
    const { client } = await owner();
    const account = await userRow(client.email);

    const [done, unknown, help] = await Promise.all([
      cli('reset-two-factor', '--email', ` ${client.email.toUpperCase()} `),
      cli('reset-two-factor', '--email', 'nobody@example.org'),
      cli('help'),
    ]);
    expect(done).toMatchObject({ code: 0, stderr: '' });
    expect(done.stdout).toContain(`Two-step verification is off for ${client.email}`);
    expect(done.stdout).toContain('REQUIRE_MFA_FOR_ADMINS=true');
    expect((await userRow(client.email)).twoFactorEnabled).toBe(false);
    expect(await resetEvents(account.id)).toHaveLength(1);

    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No account uses nobody@example.org');

    expect(help.stdout).toContain('node dist/cli.js reset-two-factor --email <address>');

    const again = await cli('reset-two-factor', '--email', client.email);
    expect(again).toMatchObject({ code: 0 });
    expect(again.stdout).toContain(`Two-step verification isn't on for ${client.email}`);
    expect(await resetEvents(account.id)).toHaveLength(1);
  });
});
