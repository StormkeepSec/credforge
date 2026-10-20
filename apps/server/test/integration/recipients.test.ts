import type {
  AccountEmail,
  AuditEventPage,
  RecipientCredential,
  RecipientCredentialPage,
} from '@credforge/contracts';
import { and, auditEvent, eq, inArray, organization, user, userEmail } from '@credforge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmedAddresses } from '../../src/recipients/addresses';
import {
  expectProblem,
  lastEmailTo,
  linkIn,
  newUser,
  TestClient,
  verificationLink,
} from './support/client';
import { BASE_URL, createTestEnvironment, type TestEnvironment } from './support/harness';
import { awardTo, type IssuingOrg, issuingOrg, publishedAchievement } from './support/issuing';
import { googleClaims, microsoftClaims, OAUTH_ENV, oauthSignIn } from './support/oauth';

/**
 * My badges (design plan §8.8, decisions 52–54): a person sees every badge awarded to the
 * addresses their account has confirmed, from every org, and nothing else. Recipients aren't
 * members of anything, aren't made to use two-step verification, and API keys never reach them.
 */

let env: TestEnvironment;
let academy: IssuingOrg;
let guild: IssuingOrg;

const path = (url: string) => url.replace(BASE_URL, '');
const anonymous = (url: string, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'GET', url: path(url), headers });

async function myBadges(client: TestClient): Promise<RecipientCredentialPage> {
  const response = await client.get('/api/v1/me/credentials');
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as RecipientCredentialPage;
}

const idsOf = (page: RecipientCredentialPage) => page.credentials.map((badge) => badge.id).sort();

/** A recipient's own account, signed in, with no two-step verification. */
const recipientAccount = (email: string, name = 'Riley Recipient') =>
  newUser(env, { email, name, twoFactor: false });

function claimTokenIn(env: TestEnvironment, email: string): string {
  return linkIn(lastEmailTo(env, email, 'award').text, /\?t=\S+/).slice(3);
}

beforeAll(async () => {
  // Open sign-up: new orgs are active, so they can award to anyone at once.
  env = await createTestEnvironment({
    SIGNUP_MODE: 'open',
    REQUIRE_MFA_FOR_ADMINS: 'true',
    ...OAUTH_ENV,
  });
  academy = await issuingOrg(env, 'Example Cyber Academy');
  guild = await issuingOrg(env, 'Defenders Guild');
});
afterAll(async () => {
  await env?.close();
});

describe('My badges', () => {
  it('lists the badges awarded to the verified address, by every org, newest first', async () => {
    const email = 'riley@example.org';
    // Awards normalize addresses (trimmed, lowercase); so does the matching.
    const first = await awardTo(academy, {
      name: 'Riley Recipient',
      email: '  Riley@Example.ORG ',
    });
    const second = await awardTo(guild, { name: 'Riley R.', email });
    await awardTo(academy, { name: 'Someone Else', email: 'someone@example.org' });

    const riley = await recipientAccount(email);
    const me = await riley.me();
    // A recipient isn't a member of anything and isn't made to set up two-step verification,
    // even with REQUIRE_MFA_FOR_ADMINS=true.
    expect(me.memberships).toEqual([]);
    expect(me.mfa).toEqual({ state: 'ok', required: false });

    const page = await myBadges(riley);
    expect(page.addresses).toEqual([email]);
    expect(page.credentials.map((badge) => badge.id)).toEqual([second, first]);
    const [fromGuild, fromAcademy] = page.credentials as [RecipientCredential, RecipientCredential];
    expect(fromAcademy).toMatchObject({
      url: `${BASE_URL}/credentials/${first}`,
      achievement: { id: academy.achievementId, name: 'Intro to Network Defense' },
      issuer: { id: academy.issuerId, name: 'Example Cyber Academy' },
      recipient: { name: 'Riley Recipient', email },
      state: 'valid',
      revocation: null,
      visibility: 'public',
      downloads: {
        png: `${BASE_URL}/credentials/${first}/badge.png`,
        svg: `${BASE_URL}/credentials/${first}/badge.svg`,
        json: `${BASE_URL}/credentials/${first}/credential.json`,
      },
    });
    expect(fromAcademy.achievement.image).toMatch(/^https:\/\/credforge\.test\/achievements\//);
    expect(new URL(fromAcademy.linkedInUrl).searchParams.get('certUrl')).toBe(fromAcademy.url);
    expect(fromGuild.issuer.name).toBe('Defenders Guild');

    // One badge on its own, and paging.
    const one = await riley.get(`/api/v1/me/credentials/${first}`);
    expect(one.statusCode).toBe(200);
    expect((one.json() as RecipientCredential).id).toBe(first);
    const paged = (
      await riley.get('/api/v1/me/credentials?limit=1')
    ).json() as RecipientCredentialPage;
    expect(paged.credentials.map((badge) => badge.id)).toEqual([second]);
    const rest = (
      await riley.get(
        `/api/v1/me/credentials?limit=1&before=${encodeURIComponent(paged.next ?? '')}`,
      )
    ).json() as RecipientCredentialPage;
    expect(rest.credentials.map((badge) => badge.id)).toEqual([first]);
    expect(rest.next).toBeNull();

    // No org permissions come with it.
    expect((await riley.get(`${academy.api}/credentials`)).statusCode).toBe(404);
    expect((await riley.get(`${academy.api}`)).statusCode).toBe(404);
  });

  it('shows org members their own badges too', async () => {
    // The guild's owner is awarded a badge by the academy.
    const id = await awardTo(academy, { name: 'Guild Owner', email: guild.owner.email });
    const page = await myBadges(guild.owner);
    expect(page.credentials.map((badge) => badge.id)).toContain(id);
    // Only their own: none of the badges the guild awarded to others.
    expect(page.credentials.every((badge) => badge.recipient.email === guild.owner.email)).toBe(
      true,
    );
  });

  it('marks revoked, replaced and expired badges, never erased ones, and lists hidden ones', async () => {
    const email = 'casey@example.org';
    const revoked = await awardTo(academy, { name: 'Casey', email });
    await academy.owner.post(`${academy.api}/credentials/${revoked}/revoke`, {
      reason: 'Internal: exam irregularity',
      publicReason: 'Awarded in error',
    });
    const replaced = await awardTo(guild, { name: 'Casy', email });
    const corrected = await guild.owner.post(`${guild.api}/credentials/${replaced}/reissue`, {
      recipient: { name: 'Casey' },
      reason: 'Typo in the name',
    });
    expect(corrected.statusCode, corrected.body).toBe(201);
    const correctedId = (corrected.json() as { id: string }).id;
    const expired = await awardTo(
      guild,
      { name: 'Casey', email },
      {
        issuedOn: '2020-01-01',
        expiresOn: '2021-01-01',
      },
    );
    const hidden = await awardTo(guild, { name: 'Casey', email });
    const hide = await anonymous(`/credentials/${hidden}?t=${claimTokenIn(env, email)}`);
    const claimCookie = hide.headers['set-cookie']?.toString().split(';')[0] ?? '';
    await env.app.inject({
      method: 'POST',
      url: `/credentials/${hidden}/visibility`,
      headers: {
        origin: BASE_URL,
        cookie: claimCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'visibility=hidden',
    });
    // An org of its own, whose badge to Casey is then erased (§12.1).
    const other = await issuingOrg(env, 'Erasing Org');
    const erased = await awardTo(other, { name: 'Casey', email });
    const erasure = await other.owner.post(`${other.api}/credentials/${erased}/erasure`);
    expect(erasure.statusCode, erasure.body).toBe(200);

    const casey = await recipientAccount(email, 'Casey');
    const page = await myBadges(casey);
    expect(idsOf(page)).toEqual([revoked, replaced, correctedId, expired, hidden].sort());
    const byId = new Map(page.credentials.map((badge) => [badge.id, badge]));
    expect(byId.get(revoked)).toMatchObject({
      state: 'revoked',
      revocation: { kind: 'revoked', publicReason: 'Awarded in error' },
    });
    expect(JSON.stringify(page)).not.toContain('irregularity');
    expect(byId.get(replaced)).toMatchObject({
      state: 'revoked',
      revocation: { kind: 'superseded' },
    });
    expect(byId.get(correctedId)).toMatchObject({ state: 'valid', recipient: { name: 'Casey' } });
    expect(byId.get(expired)).toMatchObject({ state: 'expired', revocation: null });
    expect(byId.get(hidden)).toMatchObject({ state: 'valid', visibility: 'hidden' });
    expect((await casey.get(`/api/v1/me/credentials/${erased}`)).statusCode).toBe(404);
  });

  it('lets the recipient hide and show a page, recorded in the org’s log as the recipient', async () => {
    const email = 'devon@example.org';
    const id = await awardTo(academy, { name: 'Devon Holder', email });
    const devon = await recipientAccount(email, 'Devon Holder');

    const hidden = await devon.patch(`/api/v1/me/credentials/${id}`, { visibility: 'hidden' });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect((hidden.json() as RecipientCredential).visibility).toBe('hidden');
    // Everyone else gets "not found", page and downloads alike.
    for (const suffix of ['', '/badge.png', '/credential.json', '/certificate']) {
      expect(
        (await anonymous(`/credentials/${id}${suffix}`, { accept: 'text/html' })).statusCode,
      ).toBe(404);
    }
    // Signed in with the address, the recipient still sees all of it, uncached.
    const page = await devon.get(`/credentials/${id}`, { accept: 'text/html' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect(page.body).toContain('This is your badge');
    expect(page.body).toContain('signed in to credforge');
    expect(page.body).toContain('href="/app/badges"');
    expect((await devon.get(`/credentials/${id}/badge.png`)).statusCode).toBe(200);
    expect((await devon.get(`/credentials/${id}/credential.json`)).statusCode).toBe(200);
    expect(
      (await devon.patch(`/api/v1/me/credentials/${id}`, { visibility: 'hidden' })).statusCode,
    ).toBe(200);

    // The page's own form works for the signed-in recipient too.
    const form = await env.app.inject({
      method: 'POST',
      url: `/credentials/${id}/visibility`,
      headers: {
        origin: BASE_URL,
        cookie: devon.cookieHeader(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'visibility=public',
    });
    expect(form.statusCode).toBe(303);
    expect((await anonymous(`/credentials/${id}`, { accept: 'text/html' })).statusCode).toBe(200);
    expectProblem(
      await devon.patch(`/api/v1/me/credentials/${id}`, { visibility: 'secret' }),
      400,
      'validation_failed',
    );

    // The org sees the recipient's changes, as through the claim link: one event per change.
    const log = (
      await academy.owner.get(`${academy.api}/audit-events?limit=100`)
    ).json() as AuditEventPage;
    const events = log.events.filter(
      (event) => event.target?.id === id && event.action.startsWith('credential.'),
    );
    expect(events.map((event) => event.action)).toEqual([
      'credential.shown',
      'credential.hidden',
      'credential.issued',
    ]);
    for (const event of events.slice(0, 2)) {
      expect(event.actor).toMatchObject({ type: 'recipient', id: null, label: 'Devon Holder' });
    }
  });
});

describe('only verified addresses', () => {
  it('shows nothing to someone who signs up with another person’s address', async () => {
    const victim = 'victim@example.org';
    const id = await awardTo(academy, { name: 'Victim', email: victim });
    const intruder = new TestClient(env, victim, 'a password of my own');
    const signUp = await intruder.post('/api/auth/sign-up/email', {
      name: 'Intruder',
      email: victim,
      password: intruder.password,
    });
    expect(signUp.statusCode).toBe(200);
    // No session until the address is confirmed, so nothing to see.
    expect(intruder.cookies.size).toBe(0);
    expect((await intruder.get('/api/v1/me/credentials')).statusCode).toBe(401);
    expect((await intruder.get(`/api/v1/me/credentials/${id}`)).statusCode).toBe(401);
  });

  it('refuses a session whose address isn’t verified, everywhere a recipient acts', async () => {
    // Belt and braces: even if an unverified account had a session, it would see nothing.
    const email = 'unverified-holder@example.org';
    const id = await awardTo(academy, { name: 'Holder', email });
    const holder = await recipientAccount(email, 'Holder');
    await holder.patch(`/api/v1/me/credentials/${id}`, { visibility: 'hidden' });
    await env.ownerDb.update(user).set({ emailVerified: false }).where(eq(user.email, email));

    expectProblem(await holder.get('/api/v1/me/credentials'), 403, 'email_not_verified');
    expectProblem(await holder.get(`/api/v1/me/credentials/${id}`), 403, 'email_not_verified');
    expectProblem(
      await holder.patch(`/api/v1/me/credentials/${id}`, { visibility: 'public' }),
      403,
      'email_not_verified',
    );
    expectProblem(await holder.get('/api/v1/me/emails'), 403, 'email_not_verified');
    // The hidden page and its downloads stay hidden from this session, and its form refuses.
    expect((await holder.get(`/credentials/${id}`, { accept: 'text/html' })).statusCode).toBe(404);
    expect((await holder.get(`/credentials/${id}/badge.png`)).statusCode).toBe(404);
    const form = await holder.request('POST', `/credentials/${id}/visibility`, undefined, {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(form.statusCode).toBe(403);
    const [row] = await env.ownerDb.select().from(user).where(eq(user.email, email));
    expect(await confirmedAddresses(env.db, row as typeof user.$inferSelect)).toEqual([]);
  });

  it('trusts Google’s email_verified, and otherwise waits for credforge’s confirmation', async () => {
    const trusted = 'google-trusted@example.org';
    const trustedBadge = await awardTo(academy, { name: 'G Trusted', email: trusted });
    const viaGoogle = new TestClient(env, trusted, '');
    await oauthSignIn(viaGoogle, 'google', googleClaims(trusted));
    expect(idsOf(await myBadges(viaGoogle))).toEqual([trustedBadge]);

    const unverified = 'google-unverified@example.org';
    const unverifiedBadge = await awardTo(academy, { name: 'G Unverified', email: unverified });
    const client = new TestClient(env, unverified, '');
    await oauthSignIn(client, 'google', googleClaims(unverified, { email_verified: false }));
    expect((await client.get('/api/v1/me/credentials')).statusCode).toBe(401);
    // Confirming the address with credforge's own email signs in, and the badge shows.
    const link = new URL(verificationLink(env, unverified));
    await client.get(link.pathname + link.search);
    expect(idsOf(await myBadges(client))).toEqual([unverifiedBadge]);
  });

  it('trusts Microsoft’s email only with xms_edov', async () => {
    const trusted = 'ms-trusted@example.org';
    const trustedBadge = await awardTo(academy, { name: 'M Trusted', email: trusted });
    const viaMicrosoft = new TestClient(env, trusted, '');
    await oauthSignIn(viaMicrosoft, 'microsoft', microsoftClaims(trusted, { xms_edov: true }));
    expect(idsOf(await myBadges(viaMicrosoft))).toEqual([trustedBadge]);

    const spoofed = 'ms-spoofed@example.org';
    await awardTo(academy, { name: 'M Spoofed', email: spoofed });
    const client = new TestClient(env, spoofed, '');
    // Anyone with an Entra tenant can claim any address without xms_edov (the nOAuth issue).
    const callback = await oauthSignIn(client, 'microsoft', microsoftClaims(spoofed));
    expect(callback.headers.location).toContain('error=email_not_verified');
    expect((await client.get('/api/v1/me/credentials')).statusCode).toBe(401);
  });
});

describe('isolation', () => {
  it('never shows or changes one person’s badges for another', async () => {
    const aliceEmail = 'alice@example.org';
    const alicesBadge = await awardTo(academy, { name: 'Alice', email: aliceEmail });
    const alice = await recipientAccount(aliceEmail, 'Alice');
    await alice.patch(`/api/v1/me/credentials/${alicesBadge}`, { visibility: 'hidden' });
    const bob = await recipientAccount('bob@example.org', 'Bob');

    expect(idsOf(await myBadges(bob))).toEqual([]);
    expectProblem(await bob.get(`/api/v1/me/credentials/${alicesBadge}`), 404, 'not_found');
    expectProblem(
      await bob.patch(`/api/v1/me/credentials/${alicesBadge}`, { visibility: 'public' }),
      404,
      'not_found',
    );
    // Her hidden page stays hidden from Bob, and he can't change it from the page either.
    expect((await bob.get(`/credentials/${alicesBadge}`, { accept: 'text/html' })).statusCode).toBe(
      404,
    );
    const form = await env.app.inject({
      method: 'POST',
      url: `/credentials/${alicesBadge}/visibility`,
      headers: {
        origin: BASE_URL,
        cookie: bob.cookieHeader(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'visibility=public',
    });
    expect(form.statusCode).toBe(403);
    expect((await myBadges(alice)).credentials[0]?.visibility).toBe('hidden');

    // The org that awarded it sees only its own badges, through the org API; its owner's My
    // badges holds none of what the org awarded to others.
    const owners = await myBadges(academy.owner);
    expect(owners.credentials.map((badge) => badge.id)).not.toContain(alicesBadge);
    // A malformed id is just "not found".
    expect((await alice.get('/api/v1/me/credentials/not-a-uuid')).statusCode).toBe(404);
  });

  it('never lets an API key reach a person’s badges or addresses', async () => {
    const created = await academy.owner.post(`${academy.api}/api-keys`, {
      name: 'LMS',
      scopes: ['credential:read'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const { key } = created.json() as { key: string };
    const email = 'keyed@example.org';
    const id = await awardTo(academy, { name: 'Keyed', email });
    const keyed = await recipientAccount(email, 'Keyed');
    await keyed.patch(`/api/v1/me/credentials/${id}`, { visibility: 'hidden' });

    const withKey = (method: 'GET' | 'PATCH' | 'POST', url: string, cookie?: string) =>
      env.app.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          ...(cookie && { cookie }),
        },
        ...(method !== 'GET' && { payload: '{}' }),
      });
    for (const [method, url] of [
      ['GET', '/api/v1/me/credentials'],
      ['GET', `/api/v1/me/credentials/${id}`],
      ['PATCH', `/api/v1/me/credentials/${id}`],
      ['GET', '/api/v1/me/emails'],
      ['POST', '/api/v1/me/emails'],
    ] as const) {
      // With or without the person's cookies: a request with a key is never signed in by them.
      expectProblem(await withKey(method, url), 401, 'unauthenticated');
      expectProblem(await withKey(method, url, keyed.cookieHeader()), 401, 'unauthenticated');
    }
    // Nor does a key make anyone the badge's recipient on its public page.
    const page = await env.app.inject({
      method: 'GET',
      url: `/credentials/${id}`,
      headers: {
        accept: 'text/html',
        authorization: `Bearer ${key}`,
        cookie: keyed.cookieHeader(),
      },
    });
    expect(page.statusCode).toBe(404);
  });
});

describe('extra addresses', () => {
  it('shows an address’s badges once it is confirmed through its link, signed in', async () => {
    const workBadge = await awardTo(guild, { name: 'Morgan', email: 'morgan@work.example' });
    const morgan = await recipientAccount('morgan@home.example', 'Morgan');
    expect(idsOf(await myBadges(morgan))).toEqual([]);

    const added = await morgan.post('/api/v1/me/emails', { email: ' Morgan@Work.Example ' });
    expect(added.statusCode, added.body).toBe(201);
    const address = added.json() as AccountEmail;
    expect(address).toMatchObject({ email: 'morgan@work.example', verifiedAt: null });
    // Not until it's confirmed.
    expect(idsOf(await myBadges(morgan))).toEqual([]);

    const email = lastEmailTo(env, 'morgan@work.example', 'confirm-address');
    // Nothing in it comes from the account, so the form can't carry someone else's words.
    expect(email.text).not.toContain('Morgan');
    const token = new URL(
      linkIn(email.text, /https:\/\/\S+confirm-email\?token=\S+/),
    ).searchParams.get('token');
    // Someone else signed in can't confirm it, even with the link, and learns nothing about it.
    const other = await recipientAccount('other@example.org', 'Other');
    expectProblem(
      await other.post('/api/v1/me/emails/confirm', { token }),
      400,
      'email_confirmation_invalid',
    );
    expectProblem(
      await new TestClient(env, '', '').post('/api/v1/me/emails/confirm', { token }),
      401,
      'unauthenticated',
    );

    const confirmed = await morgan.post('/api/v1/me/emails/confirm', { token });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect((confirmed.json() as AccountEmail).verifiedAt).not.toBeNull();
    const page = await myBadges(morgan);
    expect(page.addresses).toEqual(['morgan@home.example', 'morgan@work.example']);
    expect(idsOf(page)).toEqual([workBadge]);
    // The badge's page recognizes Morgan through the extra address too.
    expect((await morgan.get(`/credentials/${workBadge}`, { accept: 'text/html' })).body).toContain(
      'This is your badge',
    );
    // A link works once.
    expectProblem(
      await morgan.post('/api/v1/me/emails/confirm', { token }),
      400,
      'email_confirmation_invalid',
    );

    // Removing it removes its badges from the list.
    const removed = await morgan.delete(`/api/v1/me/emails/${address.id}`);
    expect(removed.statusCode).toBe(204);
    expect(idsOf(await myBadges(morgan))).toEqual([]);
    expect((await other.delete(`/api/v1/me/emails/${address.id}`)).statusCode).toBe(404);

    const [account] = await env.ownerDb
      .select()
      .from(user)
      .where(eq(user.email, 'morgan@home.example'));
    const events = await env.ownerDb
      .select({ action: auditEvent.action, orgId: auditEvent.orgId, data: auditEvent.data })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.actorId, account?.id ?? ''),
          inArray(auditEvent.action, [
            'user.email_added',
            'user.email_confirmed',
            'user.email_removed',
          ]),
        ),
      );
    expect(events.map((event) => event.action).sort()).toEqual([
      'user.email_added',
      'user.email_confirmed',
      'user.email_removed',
    ]);
    expect(events.every((event) => event.orgId === null)).toBe(true);
  });

  it('refuses expired links, the sign-in address, duplicates and more than five', async () => {
    const jamie = await recipientAccount('jamie@example.org', 'Jamie');
    expectProblem(
      await jamie.post('/api/v1/me/emails', { email: 'JAMIE@example.org' }),
      409,
      'conflict',
    );
    expectProblem(
      await jamie.post('/api/v1/me/emails', { email: 'not an address' }),
      400,
      'validation_failed',
    );

    const added = (
      await jamie.post('/api/v1/me/emails', { email: 'jamie@old.example' })
    ).json() as AccountEmail;
    expectProblem(
      await jamie.post('/api/v1/me/emails', { email: 'jamie@old.example' }),
      409,
      'conflict',
    );
    // Sending again waits a minute.
    expectProblem(await jamie.post(`/api/v1/me/emails/${added.id}/resend`), 429, 'rate_limited');
    await env.ownerDb
      .update(userEmail)
      .set({ sentAt: new Date(Date.now() - 120_000) })
      .where(eq(userEmail.id, added.id));
    const firstToken = new URL(
      linkIn(
        lastEmailTo(env, 'jamie@old.example', 'confirm-address').text,
        /https:\/\/\S+confirm-email\?token=\S+/,
      ),
    ).searchParams.get('token');
    expect((await jamie.post(`/api/v1/me/emails/${added.id}/resend`)).statusCode).toBe(200);
    // The earlier link stopped working.
    expectProblem(
      await jamie.post('/api/v1/me/emails/confirm', { token: firstToken }),
      400,
      'email_confirmation_invalid',
    );
    // So does one that expired.
    const latest = new URL(
      linkIn(
        lastEmailTo(env, 'jamie@old.example', 'confirm-address').text,
        /https:\/\/\S+confirm-email\?token=\S+/,
      ),
    ).searchParams.get('token');
    await env.ownerDb
      .update(userEmail)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(userEmail.id, added.id));
    expectProblem(
      await jamie.post('/api/v1/me/emails/confirm', { token: latest }),
      400,
      'email_confirmation_invalid',
    );

    for (const n of [2, 3, 4, 5]) {
      expect(
        (await jamie.post('/api/v1/me/emails', { email: `jamie${n}@example.net` })).statusCode,
      ).toBe(201);
    }
    expectProblem(
      await jamie.post('/api/v1/me/emails', { email: 'jamie6@example.net' }),
      409,
      'conflict',
    );
    const list = (await jamie.get('/api/v1/me/emails')).json() as { emails: AccountEmail[] };
    expect(list.emails).toHaveLength(5);
  });

  it('lets two accounts confirm the same address, without telling either about the other', async () => {
    // A shared inbox: both proved they can read it, as a claim link does.
    const shared = 'team@example.org';
    const badge = await awardTo(academy, { name: 'The Team', email: shared });
    for (const who of ['first@example.org', 'second@example.org']) {
      const client = await recipientAccount(who, who);
      expect((await client.post('/api/v1/me/emails', { email: shared })).statusCode).toBe(201);
      const token = new URL(
        linkIn(
          lastEmailTo(env, shared, 'confirm-address').text,
          /https:\/\/\S+confirm-email\?token=\S+/,
        ),
      ).searchParams.get('token');
      expect((await client.post('/api/v1/me/emails/confirm', { token })).statusCode).toBe(200);
      expect(idsOf(await myBadges(client))).toEqual([badge]);
    }
  });
});

describe('public pages', () => {
  it('invites a recipient with the claim link to keep their badges in one place', async () => {
    const email = 'quinn@example.org';
    const id = await awardTo(academy, { name: 'Quinn', email });
    const claimed = await anonymous(`/credentials/${id}?t=${claimTokenIn(env, email)}`);
    const claimCookie = claimed.headers['set-cookie']?.toString().split(';')[0] ?? '';

    // Signed out: create an account or sign in, coming back to My badges.
    const signedOut = await anonymous(`/credentials/${id}`, {
      accept: 'text/html',
      cookie: claimCookie,
    });
    expect(signedOut.body).toContain('This is your badge');
    expect(signedOut.body).toContain('href="/signup?redirect=%2Fapp%2Fbadges"');
    expect(signedOut.body).toContain('href="/login?redirect=%2Fapp%2Fbadges"');
    // Visitors without the link see none of it.
    const visitor = await anonymous(`/credentials/${id}`, { accept: 'text/html' });
    expect(visitor.body).not.toContain('This is your badge');
    expect(visitor.headers['cache-control']).toBe('public, max-age=60');

    // Signed in to an account without that address: where to add it.
    const other = await recipientAccount('quinn-other@example.org', 'Quinn Other');
    const signedInElsewhere = await env.app.inject({
      method: 'GET',
      url: `/credentials/${id}`,
      headers: { accept: 'text/html', cookie: `${other.cookieHeader()}; ${claimCookie}` },
    });
    expect(signedInElsewhere.body).toContain('href="/app/settings"');
    expect(signedInElsewhere.headers['cache-control']).toBe('private, no-store');

    // An expired link points to signing in.
    const expired = await anonymous(`/credentials/${id}?link=expired`, { accept: 'text/html' });
    expect(expired.body).toContain('This link no longer works');
    expect(expired.body).toContain('href="/login?redirect=%2Fapp%2Fbadges"');
  });

  it('invites recipients from the landing page', async () => {
    const landing = await anonymous('/', { accept: 'text/html' });
    expect(landing.statusCode).toBe(200);
    expect(landing.body).toContain('Received a badge?');
    expect(landing.body).toContain('href="/signup?redirect=%2Fapp%2Fbadges"');
  });
});

describe('invite-only instance (SIGNUP_MODE=invite)', () => {
  let invite: TestEnvironment;
  beforeAll(async () => {
    invite = await createTestEnvironment({ SIGNUP_MODE: 'invite' });
  });
  afterAll(async () => {
    await invite?.close();
  });

  it('lets people who were awarded a badge create an account, and nobody else', async () => {
    // A platform admin (invited, then made admin as the CLI would) runs an org there.
    const [seedOrg] = await invite.ownerDb
      .insert(organization)
      .values({ name: 'Seed', status: 'active' })
      .returning();
    await invite.ownerDb.execute(
      `insert into invitation (org_id, email, role, token_hash, expires_at) values ('${seedOrg?.id}', 'admin@example.org', 'owner', 'x', now() + interval '1 day')`,
    );
    const admin = await newUser(invite, { email: 'admin@example.org', platformAdmin: true });
    const created = await admin.post('/api/v1/orgs', { name: 'Invite Academy' });
    expect(created.statusCode, created.body).toBe(201);
    const orgId = (created.json() as { id: string }).id;
    const api = `/api/v1/orgs/${orgId}`;
    const issuer = await admin.post(`${api}/issuers`, { name: 'Invite Academy' });
    const achievementId = await publishedAchievement(admin, api, 'Invite-only badge');
    const org: IssuingOrg = {
      owner: admin,
      orgId,
      issuerId: (issuer.json() as { id: string }).id,
      achievementId,
      api,
    };
    const id = await awardTo(org, { name: 'Avery', email: 'avery@example.org' });

    // A stranger gets Better Auth's usual answer, and nothing is created.
    const stranger = new TestClient(invite, 'stranger@example.org', 'correct horse battery');
    const refused = await stranger.post('/api/auth/sign-up/email', {
      name: 'Stranger',
      email: stranger.email,
      password: stranger.password,
    });
    expect(refused.statusCode).toBe(200);
    expect(await invite.ownerDb.select().from(user).where(eq(user.email, stranger.email))).toEqual(
      [],
    );

    // The badge's recipient can, sees it, and still can't create an org.
    const avery = await newUser(invite, { email: 'avery@example.org', twoFactor: false });
    const page = (await avery.get('/api/v1/me/credentials')).json() as RecipientCredentialPage;
    expect(page.credentials.map((badge) => badge.id)).toEqual([id]);
    expectProblem(await avery.post('/api/v1/orgs', { name: 'Mine' }), 403, 'signup_closed');
  });
});
