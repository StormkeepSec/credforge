import { createHash } from 'node:crypto';
import {
  achievementRevision,
  auditEvent,
  credential,
  emailMessage,
  eq,
  file,
  organization,
  statusList,
} from '@credforge/db';
import {
  extractFromPng,
  type SignedOpenBadgeCredential,
  validateCredentialSchema,
  verifyCredential,
  verifyRecipient,
} from '@credforge/ob3';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BADGE_SVG, jpeg, pngWithMetadata } from '../support/images';
import { expectProblem, lastEmailTo, newUser, type TestClient } from './support/client';
import { BASE_URL, createTestEnvironment, type TestEnvironment } from './support/harness';

let env: TestEnvironment;
let owner: TestClient;
let admin: TestClient;
let orgId: string;
let issuerId: string;
let achievementId: string;

interface AchievementBody {
  id: string;
  url: string;
  status: string;
  revision: number;
  image: { url: string; url512: string; url128: string; ogUrl: string; mimeType: string } | null;
  awardedCount: number;
}

interface CredentialBody {
  id: string;
  url: string;
  delivery: string;
  achievement: { revision: number };
  document: SignedOpenBadgeCredential;
  emails: { id: string; status: string }[];
  claimLinkExpiresAt: string | null;
}

const path = (url: string) => url.replace(BASE_URL, '');

/** GET as a verifier would: JSON, no cookies. */
async function fetchJson(url: string) {
  const response = await env.app.inject({
    method: 'GET',
    url: path(url),
    headers: { accept: 'application/json' },
  });
  return response.statusCode === 200 ? response.json() : undefined;
}

async function anonymous(url: string, headers: Record<string, string> = {}) {
  return env.app.inject({ method: 'GET', url: path(url), headers });
}

async function newAchievement(body: Record<string, unknown> = {}) {
  const response = await owner.post(`/api/v1/orgs/${orgId}/achievements`, {
    name: 'Intro to Network Defense',
    description: 'Recognizes foundational skills in defending small networks.',
    criteriaNarrative: 'Completed all six labs and scored 80% or higher on the final assessment.',
    tags: ['networking', 'security'],
    alignments: [
      {
        targetName: 'Network defense',
        targetUrl: 'https://example.org/frameworks/net-defense',
        targetFramework: 'Example Framework',
        targetCode: 'ND-1',
      },
    ],
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as AchievementBody;
}

async function award(body: Record<string, unknown>) {
  return owner.post(`/api/v1/orgs/${orgId}/credentials`, {
    achievementId,
    recipient: { name: 'Jordan Rivera', email: owner.email },
    ...body,
  });
}

beforeAll(async () => {
  env = await createTestEnvironment({
    SIGNUP_MODE: 'approval',
    DEFAULT_ORG_DAILY_SEND_LIMIT: '50',
  });
  owner = await newUser(env, { name: 'Jordan Rivera' });
  admin = await newUser(env, { platformAdmin: true });
  orgId = (
    (await owner.post('/api/v1/orgs', { name: 'Example Cyber Academy' })).json() as { id: string }
  ).id;
  issuerId = (
    (
      await owner.post(`/api/v1/orgs/${orgId}/issuers`, {
        name: 'Example Cyber Academy',
        url: 'https://example.org',
        email: 'badges@example.org',
      })
    ).json() as { id: string }
  ).id;
});
afterAll(async () => {
  await env?.close();
});

describe('achievements', () => {
  it('creates a draft, refuses to publish it without an image, then publishes', async () => {
    const created = await newAchievement();
    achievementId = created.id;
    expect(created).toMatchObject({
      url: `${BASE_URL}/achievements/${created.id}`,
      status: 'draft',
      revision: 1,
      image: null,
    });
    // Drafts aren't public.
    expect((await anonymous(created.url, { accept: 'text/html' })).statusCode).toBe(404);

    const early = await owner.post(`/api/v1/orgs/${orgId}/achievements/${created.id}/publish`);
    expectProblem(early, 400, 'validation_failed');

    const upload = await owner.upload(
      `/api/v1/orgs/${orgId}/achievements/${created.id}/image`,
      await pngWithMetadata(),
      'image/png',
    );
    expect(upload.statusCode, upload.body).toBe(200);
    const withImage = upload.json() as AchievementBody;
    expect(withImage.revision).toBe(2);
    expect(withImage.image?.url).toMatch(
      new RegExp(`^${BASE_URL}/achievements/${created.id}/images/[0-9a-f]{64}\\.png$`),
    );

    const published = await owner.post(`/api/v1/orgs/${orgId}/achievements/${created.id}/publish`);
    expect(published.statusCode).toBe(200);
    expect((published.json() as AchievementBody).status).toBe('active');
  });

  it('cleans uploads: re-encodes without metadata and serves content-addressed variants', async () => {
    const { image } = (
      await owner.get(`/api/v1/orgs/${orgId}/achievements/${achievementId}`)
    ).json() as AchievementBody;
    if (!image) throw new Error('no image');
    const original = await anonymous(image.url);
    expect(original.statusCode).toBe(200);
    expect(original.headers['content-type']).toBe('image/png');
    expect(original.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(original.headers['x-content-type-options']).toBe('nosniff');
    expect(original.headers['content-security-policy']).toContain('sandbox');
    expect(original.rawPayload.includes(Buffer.from('secret location'))).toBe(false);
    expect((await sharp(original.rawPayload).metadata()).exif).toBeUndefined();
    // The URL is the hash of the bytes.
    const hash = createHash('sha256').update(original.rawPayload).digest('hex');
    expect(image.url).toContain(hash);

    for (const [url, width, height] of [
      [image.url512, 512, 512],
      [image.url128, 128, 128],
      [image.ogUrl, 1200, 630],
    ] as const) {
      const response = await anonymous(url);
      expect(response.statusCode, url).toBe(200);
      const meta = await sharp(response.rawPayload).metadata();
      expect([meta.width, meta.height], url).toEqual([width, height]);
    }
    const etag = original.headers.etag as string;
    expect((await anonymous(image.url, { 'if-none-match': etag })).statusCode).toBe(304);
    expect((await anonymous(image.url.replace('.png', '.svg'))).statusCode).toBe(404);
  });

  it('turns JPEG into PNG, sanitizes SVG, and refuses other files', async () => {
    const other = await newAchievement({ name: 'Second' });
    const url = `/api/v1/orgs/${orgId}/achievements/${other.id}/image`;

    const fromJpeg = await owner.upload(url, await jpeg(), 'image/jpeg');
    expect((fromJpeg.json() as AchievementBody).image?.mimeType).toBe('image/png');

    const evil = BADGE_SVG.replace(
      '<title>',
      '<script>alert(1)</script><foreignObject><p>x</p></foreignObject><title>',
    ).replace('<circle', '<circle onclick="alert(1)"');
    const fromSvg = await owner.upload(url, Buffer.from(evil), 'image/svg+xml');
    expect(fromSvg.statusCode, fromSvg.body).toBe(200);
    const svgImage = (fromSvg.json() as AchievementBody).image;
    expect(svgImage?.mimeType).toBe('image/svg+xml');
    const served = await anonymous(svgImage?.url ?? '');
    expect(served.headers['content-type']).toBe('image/svg+xml');
    expect(served.body).not.toMatch(/script|foreignObject|onclick/);
    expect(served.body).toContain('<circle');

    // Declared as PNG, but the bytes are HTML: refused by its bytes.
    expectProblem(
      await owner.upload(url, Buffer.from('<html><script>x</script></html>'), 'image/png'),
      415,
      'unsupported_file',
    );
    expectProblem(
      await owner.upload(url, Buffer.alloc(2 * 1024 * 1024 + 10, 1), 'image/png'),
      413,
      'file_too_large',
    );

    // Drafts can be deleted, with their images (none is retained).
    const images = await env.ownerDb.select().from(file).where(eq(file.subjectId, other.id));
    expect(images.length).toBe(2);
    expect((await owner.delete(`/api/v1/orgs/${orgId}/achievements/${other.id}`)).statusCode).toBe(
      204,
    );
    expect(await env.ownerDb.select().from(file).where(eq(file.subjectId, other.id))).toEqual([]);
    expect((await anonymous(svgImage?.url ?? '')).statusCode).toBe(404);
  });

  it('serves the published achievement as a page and as OB Achievement JSON', async () => {
    const url = `${BASE_URL}/achievements/${achievementId}`;
    const html = await anonymous(url, { accept: 'text/html' });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('Intro to Network Defense');
    expect(html.body).toContain('og:image');

    const json = (await fetchJson(url)) as Record<string, unknown>;
    expect(json).toMatchObject({
      id: url,
      type: ['Achievement'],
      achievementType: 'Badge',
      name: 'Intro to Network Defense',
      criteria: { narrative: expect.stringContaining('six labs') },
      tag: ['networking', 'security'],
      creator: { id: `${BASE_URL}/issuers/${issuerId}`, name: 'Example Cyber Academy' },
    });
  });
});

describe('awarding while the org is pending', () => {
  it('refuses recipients who aren’t members with a confirmed address', async () => {
    const response = await award({
      recipient: { name: 'Someone Else', email: 'someone.else@example.org' },
    });
    expectProblem(response, 403, 'recipient_not_allowed');
    expect(await env.ownerDb.select().from(credential)).toEqual([]);
  });

  it('refuses drafts', async () => {
    const draft = await newAchievement({ name: 'Draft only' });
    expectProblem(await award({ achievementId: draft.id }), 409, 'achievement_not_active');
  });

  it('awards to a member: signed, verifiable, emailed with a claim link', async () => {
    const response = await award({
      evidence: [{ url: 'https://example.org/labs/jordan', narrative: 'All six labs.' }],
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as CredentialBody;
    expect(body).toMatchObject({
      url: `${BASE_URL}/credentials/${body.id}`,
      delivery: 'queued',
      achievement: { revision: 2 },
    });
    const doc = body.document;
    expect(doc.id).toBe(body.url);
    expect(doc.issuer).toMatchObject({
      id: `${BASE_URL}/issuers/${issuerId}`,
      url: 'https://example.org',
    });
    expect(doc.credentialSubject.achievement.image?.id).toMatch(/\/images\/[0-9a-f]{64}\.png$/);
    expect(doc.credentialStatus).toMatchObject({
      type: 'BitstringStatusListEntry',
      statusListCredential: `${BASE_URL}/status/${issuerId}/1`,
    });
    expect(doc.evidence).toEqual([
      { id: 'https://example.org/labs/jordan', type: ['Evidence'], narrative: 'All six labs.' },
    ]);
    expect(validateCredentialSchema(doc).valid).toBe(true);
    expect(verifyRecipient(doc, { identityType: 'emailAddress', value: owner.email })).toBe(true);

    // Verified the way an outside verifier would: issuer profile and status list over HTTP.
    const result = await verifyCredential(doc, {
      resolveController: fetchJson,
      loadStatusListCredential: fetchJson,
    });
    expect(result.checks).toMatchObject({
      format: { outcome: 'passed' },
      proof: { outcome: 'passed' },
      status: { outcome: 'passed' },
      validity: { outcome: 'passed' },
    });
    expect(result.verified).toBe(true);

    const [row] = await env.ownerDb.select().from(credential).where(eq(credential.id, body.id));
    expect(row?.claimTokenHash).toMatch(/^[0-9a-f]{64}$/);
    const days = (row?.claimTokenExpiresAt?.getTime() ?? 0) - Date.now();
    expect(Math.round(days / 86_400_000)).toBe(90);
    // The image the credential uses is kept forever.
    const [image] = await env.ownerDb
      .select()
      .from(file)
      .where(eq(file.id, row?.imageFileId ?? ''));
    expect(image?.retain).toBe(true);

    const email = lastEmailTo(env, owner.email, 'award');
    expect(email.subject).toBe('Example Cyber Academy awarded you Intro to Network Defense');
    expect(email.fromName).toBe('Example Cyber Academy via credforge');
    expect(email.replyTo).toBe('badges@example.org');
    expect(email.trackingId).toBe(body.emails[0]?.id);
    expect(email.text).toContain(`${body.url}?t=`);
    expect(email.html).toContain('-512.png');

    const events = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.targetId, body.id));
    expect(events.map((event) => event.action)).toEqual(['credential.issued']);
  });

  it('publishes the signed status list with an ETag and a short cache time', async () => {
    const url = `/status/${issuerId}/1`;
    const response = await anonymous(url);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.json()).toMatchObject({
      id: `${BASE_URL}${url}`,
      type: ['VerifiableCredential', 'BitstringStatusListCredential'],
      proof: { type: 'DataIntegrityProof' },
    });
    const again = await anonymous(url, { 'if-none-match': response.headers.etag as string });
    expect(again.statusCode).toBe(304);
    // Repeated fetches (the 1EdTech validator makes about 10 per check) are all answered.
    for (let i = 0; i < 15; i++) expect((await anonymous(url)).statusCode).toBe(200);
  });
});

describe('the recipient’s claim link', () => {
  let credentialId: string;
  let cookie: string;

  beforeAll(async () => {
    const [row] = await env.ownerDb.select().from(credential);
    credentialId = row?.id ?? '';
  });

  it('trades the token for a cookie and the clean URL, and marks the badge accepted', async () => {
    const link = (lastEmailTo(env, owner.email, 'award').text.match(/https:\/\/\S+\?t=\S+/) ??
      [])[0];
    if (!link) throw new Error('no claim link');
    const response = await anonymous(link, { accept: 'text/html' });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`${BASE_URL}/credentials/${credentialId}`);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(
      /^cf_claim=[\w-]+; Path=\/credentials\/[0-9a-f-]+; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/,
    );
    cookie = setCookie.split(';')[0] ?? '';

    const [row] = await env.ownerDb
      .select()
      .from(credential)
      .where(eq(credential.id, credentialId));
    expect(row?.acceptedAt).toBeInstanceOf(Date);

    const page = await anonymous(`/credentials/${credentialId}`, { accept: 'text/html', cookie });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect(page.body).toContain('This is your badge');
    expect(page.body).toContain('linkedin.com/profile/add');
    expect(page.body).toContain('Signature checked with a key published by the issuer');

    const publicPage = await anonymous(`/credentials/${credentialId}`, { accept: 'text/html' });
    expect(publicPage.body).not.toContain('This is your badge');
    expect(publicPage.body).toContain('Jordan Rivera');
    expect(publicPage.body).not.toContain(owner.email);
    expect(publicPage.headers['x-robots-tag']).toBe('noindex');
  });

  it('sends a bad or old token to the public view', async () => {
    const response = await anonymous(`/credentials/${credentialId}?t=not-the-token`);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`${BASE_URL}/credentials/${credentialId}?link=expired`);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('serves the signed JSON and a baked PNG that carries it', async () => {
    const json = await anonymous(`/credentials/${credentialId}`, { accept: 'application/ld+json' });
    expect(json.headers['content-type']).toBe('application/ld+json; charset=utf-8');
    const document = json.json();

    const png = await anonymous(`/credentials/${credentialId}/badge.png`);
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-disposition']).toBe(
      'attachment; filename="intro-to-network-defense.png"',
    );
    expect(JSON.parse(extractFromPng(png.rawPayload) ?? '{}')).toEqual(document);
    // PNG artwork: no baked SVG.
    expect((await anonymous(`/credentials/${credentialId}/badge.svg`)).statusCode).toBe(404);

    const download = await anonymous(`/credentials/${credentialId}/credential.json`);
    expect(JSON.parse(download.body)).toEqual(document);
    const certificate = await anonymous(`/credentials/${credentialId}/certificate`);
    expect(certificate.statusCode).toBe(200);
    expect(certificate.body).toContain('Awarded to');
    expect(certificate.body).toContain('<svg');
  });

  it('lets the recipient hide the page, and only them', async () => {
    const form = (headers: Record<string, string>) =>
      env.app.inject({
        method: 'POST',
        url: `/credentials/${credentialId}/visibility`,
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        payload: 'visibility=hidden',
      });
    expect((await form({ origin: BASE_URL })).statusCode).toBe(403);
    expect((await form({ origin: 'https://evil.example', cookie })).statusCode).toBe(403);
    const hidden = await form({ origin: BASE_URL, cookie });
    expect(hidden.statusCode).toBe(303);

    for (const url of [
      `/credentials/${credentialId}`,
      `/credentials/${credentialId}/badge.png`,
      `/credentials/${credentialId}/credential.json`,
      `/credentials/${credentialId}/certificate`,
    ]) {
      expect((await anonymous(url, { accept: 'text/html' })).statusCode, url).toBe(404);
    }
    const mine = await anonymous(`/credentials/${credentialId}`, { accept: 'text/html', cookie });
    expect(mine.statusCode).toBe(200);
    expect(mine.body).toContain('Make the page public');

    await env.app.inject({
      method: 'POST',
      url: `/credentials/${credentialId}/visibility`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE_URL,
        cookie,
      },
      payload: 'visibility=public',
    });
    expect((await anonymous(`/credentials/${credentialId}`)).statusCode).toBe(200);
    const actions = (
      await env.ownerDb.select().from(auditEvent).where(eq(auditEvent.targetId, credentialId))
    ).map((event) => [event.action, event.actorType]);
    expect(actions).toEqual([
      ['credential.issued', 'user'],
      ['credential.claimed', 'recipient'],
      ['credential.hidden', 'recipient'],
      ['credential.shown', 'recipient'],
    ]);
  });

  it('resends a new link; the old one stops working', async () => {
    const resent = await owner.post(`/api/v1/orgs/${orgId}/credentials/${credentialId}/resend`);
    expect(resent.statusCode).toBe(200);
    expect((resent.json() as CredentialBody).emails).toHaveLength(2);
    // The old cookie holds the old token.
    const page = await anonymous(`/credentials/${credentialId}`, { accept: 'text/html', cookie });
    expect(page.body).not.toContain('This is your badge');
    const email = lastEmailTo(env, owner.email, 'award');
    expect(email.text).toContain('This is a new link');
  });
});

describe('limits and status', () => {
  it('enforces the daily send limit', async () => {
    await env.ownerDb
      .update(organization)
      .set({ dailySendLimit: 2 })
      .where(eq(organization.id, orgId));
    // Two award emails already went out (the award and the resend).
    expectProblem(await award({}), 429, 'send_limit_reached');
    // Without email there's nothing to limit.
    expect((await award({ sendEmail: false })).statusCode).toBe(201);
    await env.ownerDb
      .update(organization)
      .set({ dailySendLimit: null })
      .where(eq(organization.id, orgId));
  });

  it('awards to anyone once a platform admin approves the org', async () => {
    expect((await admin.post(`/api/v1/platform/orgs/${orgId}/approve`)).statusCode).toBe(200);
    const response = await award({
      recipient: { name: 'Sam Lee', email: 'Sam.Lee@Example.org' },
      issuedOn: '2026-01-15',
      expiresOn: '2027-01-15',
    });
    expect(response.statusCode, response.body).toBe(201);
    const doc = (response.json() as CredentialBody).document;
    expect(doc.validFrom).toBe('2026-01-15T00:00:00Z');
    expect(doc.validUntil).toBe('2027-01-15T23:59:59Z');
    expect(
      verifyRecipient(doc, { identityType: 'emailAddress', value: 'sam.lee@example.org' }),
    ).toBe(true);
    // Random, distinct indexes in the same list.
    const rows = await env.ownerDb.select().from(credential);
    const indexes = new Set(rows.map((row) => row.statusListIndex));
    expect(indexes.size).toBe(rows.length);
    const [list] = await env.ownerDb.select().from(statusList);
    expect(list?.allocatedCount).toBe(rows.length);
  });

  it('keeps issued credentials as they were when the achievement changes', async () => {
    const before = (await award({})).json() as CredentialBody;
    const patched = await owner.patch(`/api/v1/orgs/${orgId}/achievements/${achievementId}`, {
      name: 'Network Defense I',
    });
    expect((patched.json() as AchievementBody).revision).toBe(3);
    const revisions = await env.ownerDb
      .select()
      .from(achievementRevision)
      .where(eq(achievementRevision.achievementId, achievementId));
    expect(revisions.map((row) => row.revision).sort()).toEqual([1, 2, 3]);

    const stored = await anonymous(`/credentials/${before.id}`, { accept: 'application/json' });
    expect(stored.json().credentialSubject.achievement.name).toBe('Intro to Network Defense');
    const after = (await award({})).json() as CredentialBody;
    expect(after.document.credentialSubject.achievement.name).toBe('Network Defense I');
    expect(after.achievement.revision).toBe(3);
  });

  it('stops awards from an archived achievement, but keeps its page', async () => {
    await owner.post(`/api/v1/orgs/${orgId}/achievements/${achievementId}/archive`);
    expectProblem(await award({}), 409, 'achievement_not_active');
    const page = await anonymous(`/achievements/${achievementId}`, { accept: 'text/html' });
    expect(page.body).toContain('No longer awarded');
    await owner.post(`/api/v1/orgs/${orgId}/achievements/${achievementId}/restore`);
    expect((await award({ sendEmail: false })).statusCode).toBe(201);
  });

  it('refuses everything once the org is suspended', async () => {
    await admin.post(`/api/v1/platform/orgs/${orgId}/suspend`, { reason: 'Test' });
    expectProblem(await award({}), 403, 'org_inactive');
    // Existing credentials still verify.
    const [row] = await env.ownerDb.select().from(credential).limit(1);
    const result = await verifyCredential(row?.document, {
      resolveController: fetchJson,
      loadStatusListCredential: fetchJson,
    });
    expect(result.verified).toBe(true);
    await admin.post(`/api/v1/platform/orgs/${orgId}/reinstate`);
  });

  it('lists credentials newest first with their delivery status', async () => {
    const first = await owner.get(`/api/v1/orgs/${orgId}/credentials?limit=2`);
    const page = first.json() as { credentials: { id: string; delivery: string }[]; next: string };
    expect(page.credentials).toHaveLength(2);
    expect(page.next).toBeTruthy();
    const second = await owner.get(
      `/api/v1/orgs/${orgId}/credentials?limit=50&before=${encodeURIComponent(page.next)}`,
    );
    const rest = (second.json() as { credentials: { id: string }[] }).credentials;
    const all = (await env.ownerDb.select().from(credential)).length;
    expect(page.credentials.length + rest.length).toBe(all);
    const messages = await env.ownerDb.select().from(emailMessage);
    expect(messages.every((message) => message.status === 'queued')).toBe(true);
  });
});
