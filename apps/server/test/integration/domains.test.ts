import { auditEvent, eq, issuer } from '@credforge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recheckVerifiedDomains } from '../../src/issuers/domain';
import { expectProblem, newUser } from './support/client';
import { createTestEnvironment, type TestEnvironment } from './support/harness';
import { awardTo, type IssuingOrg, issuingOrg } from './support/issuing';

/**
 * Issuer domain verification (design plan §6.3): a DNS TXT record or a file proves control of the
 * website's host; public pages say "Website verified" only then, and "self-reported" otherwise.
 * The DNS and HTTPS lookups go to the harness's stand-in (`env.domainProof`).
 */

let env: TestEnvironment;
let org: IssuingOrg;

beforeAll(async () => {
  env = await createTestEnvironment({ SIGNUP_MODE: 'open' });
  org = await issuingOrg(env);
});
afterAll(async () => {
  await env?.close();
});

const start = () => org.owner.post(`${org.api}/issuers/${org.issuerId}/domain-verification`);
const check = () => org.owner.post(`${org.api}/issuers/${org.issuerId}/domain-verification/check`);
const issuerPage = () =>
  env.app.inject({
    method: 'GET',
    url: `/issuers/${org.issuerId}`,
    headers: { accept: 'text/html' },
  });

describe('domain verification', () => {
  it('gives a record and a file to publish, with a token that stays the same', async () => {
    const first = await start();
    expect(first.statusCode, first.body).toBe(200);
    const details = first.json() as {
      host: string;
      value: string;
      dnsName: string;
      fileUrl: string;
      verifiedAt: string | null;
    };
    expect(details).toMatchObject({
      host: 'example.org',
      dnsName: '_credforge.example.org',
      fileUrl: 'https://example.org/.well-known/credforge-verify.txt',
      verifiedAt: null,
    });
    expect(details.value).toMatch(/^credforge-verify=[A-Za-z0-9_-]{24}$/);
    expect((await start()).json()).toMatchObject({ value: details.value });
  });

  it('stays self-reported while nothing is published', async () => {
    const result = await check();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      verified: false,
      findings: [
        { method: 'dns', found: false },
        { method: 'file', found: false },
      ],
    });
    expect((await issuerPage()).body).toContain('Website (self-reported)');
    const listed = await org.owner.get(`${org.api}/issuers/${org.issuerId}`);
    expect(listed.json()).toMatchObject({
      domain: { host: 'example.org', verifiedAt: null, method: null },
    });
  });

  it('verifies with a DNS TXT record and says so on public pages', async () => {
    const { value } = (await start()).json() as { value: string };
    env.domainProof.txt.set('_credforge.example.org', ['v=spf1 -all', value]);
    const result = await check();
    expect(result.json()).toMatchObject({ verified: true, domain: { method: 'dns' } });

    const page = (await issuerPage()).body;
    expect(page).toContain('Website verified');
    expect(page).not.toContain('self-reported');
    const credentialId = await awardTo(org, { name: 'Jordan Rivera', email: org.owner.email });
    const credentialPage = await env.app.inject({
      method: 'GET',
      url: `/credentials/${credentialId}`,
      headers: { accept: 'text/html' },
    });
    expect(credentialPage.body).toContain('website verified:');

    const events = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, 'issuer.domain_verified'));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ domain: 'example.org', method: 'dns' });

    // Checking again keeps the original date and doesn't log it twice.
    await check();
    expect(
      await env.ownerDb
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.action, 'issuer.domain_verified')),
    ).toHaveLength(1);
    env.domainProof.txt.clear();
  });

  it('clears the proof when the website moves to another host', async () => {
    const moved = await org.owner.patch(`${org.api}/issuers/${org.issuerId}`, {
      url: 'https://badges.example.com',
    });
    expect(moved.json()).toMatchObject({
      domain: { host: 'badges.example.com', verifiedAt: null },
    });
    expect((await issuerPage()).body).toContain('Website (self-reported)');
  });

  it('verifies with the file on the website', async () => {
    const { value, fileUrl } = (await start()).json() as { value: string; fileUrl: string };
    expect(fileUrl).toBe('https://badges.example.com/.well-known/credforge-verify.txt');
    env.domainProof.files.set(fileUrl, 'something else\n');
    const wrong = await check();
    expect(wrong.json()).toMatchObject({
      verified: false,
      findings: [
        { method: 'dns', found: false },
        { method: 'file', found: false },
      ],
    });
    env.domainProof.files.set(fileUrl, `${value}\n`);
    expect((await check()).json()).toMatchObject({
      verified: true,
      domain: { host: 'badges.example.com', method: 'file' },
    });

    const platform = await newUser(env, { platformAdmin: true });
    const orgs = await platform.get('/api/v1/platform/orgs');
    const listed = (
      orgs.json() as { orgs: { id: string; issuers: { domainVerified: boolean }[] }[] }
    ).orgs.find((row) => row.id === org.orgId);
    expect(listed?.issuers[0]?.domainVerified).toBe(true);
  });

  it('lapses after three failed daily re-checks in a row', async () => {
    const day = 24 * 60 * 60 * 1000;
    // A little over a day apart, so each re-check is due.
    const later = (days: number) => new Date(Date.now() + days * day * 1.01);
    // Still published: the re-check passes.
    expect(await recheckVerifiedDomains(env.db, env.domainChecker, { now: later(1) })).toEqual({
      checked: 1,
      lapsed: 0,
    });
    env.domainProof.files.clear();
    expect(
      (await recheckVerifiedDomains(env.db, env.domainChecker, { now: later(2) })).lapsed,
    ).toBe(0);
    // Checked once a day at most.
    expect(
      (await recheckVerifiedDomains(env.db, env.domainChecker, { now: later(2) })).checked,
    ).toBe(0);
    expect(
      (await recheckVerifiedDomains(env.db, env.domainChecker, { now: later(3) })).lapsed,
    ).toBe(0);
    expect(
      (await recheckVerifiedDomains(env.db, env.domainChecker, { now: later(4) })).lapsed,
    ).toBe(1);
    const [row] = await env.ownerDb.select().from(issuer).where(eq(issuer.id, org.issuerId));
    expect(row?.domainVerifiedAt).toBeNull();
    const [event] = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, 'issuer.domain_verification_lapsed'));
    expect(event).toMatchObject({ actorType: 'system', targetId: org.issuerId });
    expect((await issuerPage()).body).toContain('Website (self-reported)');
  });

  it('needs a website with a domain name', async () => {
    await org.owner.patch(`${org.api}/issuers/${org.issuerId}`, { url: 'https://203.0.113.7' });
    expectProblem(await start(), 422, 'no_website');
    await org.owner.patch(`${org.api}/issuers/${org.issuerId}`, { url: '' });
    expectProblem(await check(), 422, 'no_website');
  });
});
