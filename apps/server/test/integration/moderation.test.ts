import { randomBytes } from 'node:crypto';
import {
  achievement,
  auditEvent,
  contentReport,
  credential,
  eq,
  instanceSettings,
  issuer,
  moderationItem,
  organization,
  sql,
} from '@credforge/db';
import { extractFromPng } from '@credforge/ob3';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backfillModerationItems, MODERATION_BACKFILLED } from '../../src/moderation/backfill';
import { placeholderPng } from '../../src/moderation/placeholders';
import { reportFormToken } from '../../src/moderation/reports';
import { BADGE_SVG } from '../support/images';
import { expectProblem, lastEmailTo, newUser, type TestClient } from './support/client';
import { BASE_URL, createTestEnvironment, type TestEnvironment } from './support/harness';
import { type IssuingOrg, issuingOrg, publishedAchievement } from './support/issuing';

/**
 * Content moderation (design plan §6.5, decisions 56–58): content held until a platform admin
 * clears it is never served publicly; the queue and its actions; reports; the word list; upload
 * limits. The terms in the word list here are made up: credforge ships none.
 */

let env: TestEnvironment;
let admin: TestClient;

interface Item {
  id: string;
  kind: 'image' | 'text';
  status: string;
  flags: { source: string; terms: string[] | null; category: string | null }[];
  subject: { type: string; id: string; name: string };
  org: { id: string };
  text: { field: string; value: string }[] | null;
  heldCredentials: number;
}

async function anonymous(url: string, accept = 'text/html', headers: Record<string, string> = {}) {
  return env.app.inject({ method: 'GET', url, headers: { accept, ...headers } });
}

async function queue(query = ''): Promise<Item[]> {
  const response = await admin.get(`/api/v1/platform/moderation/items${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { items: Item[] }).items;
}

async function itemsOf(orgId: string) {
  return queue(`?orgId=${orgId}`);
}

async function achievementOf(org: IssuingOrg, id = org.achievementId) {
  return (await org.owner.get(`${org.api}/achievements/${id}`)).json() as {
    name: string;
    image: { url: string; url512: string; ogUrl: string };
    review: { text: string; image: string | null };
    removed: { reason: string } | null;
  };
}

async function award(org: IssuingOrg, email: string, achievementId = org.achievementId) {
  return org.owner.post(`${org.api}/credentials`, {
    achievementId,
    recipient: { name: 'Sam Taylor', email },
    sendEmail: false,
  });
}

async function storedImage(org: IssuingOrg, achievementId = org.achievementId) {
  const [row] = await env.ownerDb
    .select({ fileId: achievement.imageFileId })
    .from(achievement)
    .where(eq(achievement.id, achievementId));
  const [item] = await env.ownerDb
    .select()
    .from(moderationItem)
    .where(eq(moderationItem.fileId, row?.fileId ?? ''));
  return item;
}

async function auditActions(orgId: string | null) {
  const rows = await env.db
    .select({ action: auditEvent.action, data: auditEvent.data })
    .from(auditEvent)
    .where(orgId ? eq(auditEvent.orgId, orgId) : sql`${auditEvent.orgId} is null`);
  return rows;
}

beforeAll(async () => {
  env = await createTestEnvironment({
    MODERATION_REVIEW: 'untrusted',
    // Made-up terms: anywhere (even spelled with swaps), and one as a whole word only.
    MODERATION_TEXT_BLOCKLIST: '# test list\nzorblax\n=dang',
    ABUSE_EMAIL: 'abuse@credforge.test',
    ORG_UPLOAD_RATE_LIMIT: '50',
  });
  admin = await newUser(env, { name: 'Platform Admin', platformAdmin: true });
}, 60_000);

afterAll(async () => {
  await env?.close();
});

describe('held until cleared', () => {
  let org: IssuingOrg;

  beforeAll(async () => {
    org = await issuingOrg(env, 'Held Academy');
    const logo = await org.owner.upload(
      `${org.api}/issuers/${org.issuerId}/logo`,
      Buffer.from(BADGE_SVG),
      'image/svg+xml',
    );
    expect(logo.statusCode).toBe(200);
  });

  it('serves none of a new org’s text or images publicly', async () => {
    const own = await achievementOf(org);
    expect(own.review).toEqual({ text: 'pending', image: 'pending' });

    const page = await anonymous(`/achievements/${org.achievementId}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Waiting for review');
    expect(page.body).not.toContain('Intro to Network Defense');
    expect(page.body).not.toContain('Recognizes foundational skills');
    expect(page.body).not.toContain('og:image');
    expect(page.body).not.toContain(own.image.url512);
    // The JSON has nothing cleared to show yet.
    expect(
      (await anonymous(`/achievements/${org.achievementId}`, 'application/json')).statusCode,
    ).toBe(404);

    // Each image URL answers with the neutral placeholder, never cached, for everyone else.
    const held = await placeholderPng('held', '512');
    for (const url of [own.image.url, own.image.url512, own.image.ogUrl]) {
      const response = await anonymous(url, 'image/*');
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['cache-control'], url).toBe('no-store');
      expect(response.rawPayload.equals(Buffer.from(BADGE_SVG)), url).toBe(false);
    }
    expect((await anonymous(own.image.url512, 'image/*')).rawPayload.equals(held)).toBe(true);
    // The org's own members see it, privately.
    const mine = await org.owner.get(own.image.url512.replace(BASE_URL, ''));
    expect(mine.rawPayload.equals(held)).toBe(false);
    expect(mine.headers['cache-control']).toBe('private, no-store');

    const issuerPage = await anonymous(`/issuers/${org.issuerId}`);
    expect(issuerPage.body).toContain('Issuer waiting for review');
    expect(issuerPage.body).not.toContain('Held Academy');
    expect(issuerPage.body).not.toContain('badges@example.org');
    // The profile JSON is always served, so badges verify, but without the held text.
    const profile = await anonymous(`/issuers/${org.issuerId}`, 'application/json');
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({ name: 'Issuer waiting for review' });
    expect(JSON.stringify(profile.json())).not.toContain('Held Academy');
    expect((profile.json() as { verificationMethod: unknown[] }).verificationMethod).toHaveLength(
      1,
    );
  });

  it('lets a pending org award its members, privately until the content is cleared', async () => {
    const response = await award(org, org.owner.email);
    expect(response.statusCode, response.body).toBe(201);
    const id = (response.json() as { id: string }).id;
    for (const [url, accept] of [
      [`/credentials/${id}`, 'text/html'],
      [`/credentials/${id}`, 'application/json'],
      [`/credentials/${id}/badge.png`, 'image/png'],
      [`/credentials/${id}/credential.json`, 'application/json'],
    ] as const) {
      expect((await anonymous(url, accept)).statusCode, url).toBe(404);
    }
    const checked = await env.app.inject({
      method: 'POST',
      url: '/api/v1/verify',
      payload: { url: `${BASE_URL}/credentials/${id}` },
    });
    // As for a hidden badge: as if there were none.
    expect(checked.statusCode).toBe(422);
    expect(checked.body).not.toContain('Intro to Network Defense');
    // Its recipient (a member, signed in with its address) sees it.
    expect((await org.owner.get(`/credentials/${id}`, { accept: 'text/html' })).statusCode).toBe(
      200,
    );
  });

  it('lists the content in the queue, leaving drafts out until they are published', async () => {
    const draft = await org.owner.post(`${org.api}/achievements`, {
      name: 'Draft only',
      description: 'Not public yet.',
      criteriaNarrative: 'Nothing yet.',
    });
    const draftId = (draft.json() as { id: string }).id;
    const items = await itemsOf(org.orgId);
    const kinds = items.map((item) => `${item.subject.type}:${item.kind}`).sort();
    expect(kinds).toEqual([
      'achievement:image',
      'achievement:text',
      'issuer:image',
      'issuer:text',
      'organization:text',
    ]);
    expect(items.some((item) => item.subject.id === draftId)).toBe(false);
    const text = items.find((item) => item.subject.type === 'achievement' && item.kind === 'text');
    expect(text?.text?.find((field) => field.field === 'name')?.value).toBe(
      'Intro to Network Defense',
    );
    expect(text?.heldCredentials).toBe(1);
    expect(text?.flags.map((flag) => flag.source)).toEqual(['review']);

    // The image is blurred unless asked, and never an attachment.
    const image = items.find(
      (item) => item.subject.type === 'achievement' && item.kind === 'image',
    );
    const blurred = await admin.get(`/api/v1/platform/moderation/items/${image?.id}/image`);
    expect(blurred.statusCode).toBe(200);
    expect(blurred.headers['content-type']).toBe('image/png');
    expect(blurred.headers['cache-control']).toBe('no-store');
    expect(blurred.headers['content-disposition']).toBe('inline');
    const full = await admin.get(`/api/v1/platform/moderation/items/${image?.id}/image?view=full`);
    expect(blurred.rawPayload.equals(full.rawPayload)).toBe(false);
    // Members and anyone else can't use the queue.
    expect((await org.owner.get('/api/v1/platform/moderation/items')).statusCode).toBe(403);
    expect(
      (await org.owner.get(`/api/v1/platform/moderation/items/${image?.id}/image`)).statusCode,
    ).toBe(403);
  });

  it('clears what the admin saw when approving the org; later content keeps waiting', async () => {
    const seen = await itemsOf(org.orgId);
    const later = await publishedAchievement(org.owner, org.api, 'Saved after the queue loaded');
    const approved = await admin.post(`/api/v1/platform/orgs/${org.orgId}/approve`, {
      clearItemIds: seen.map((item) => item.id),
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const own = await achievementOf(org);
    expect(own.review).toEqual({ text: 'cleared', image: 'cleared' });
    const page = await anonymous(`/achievements/${org.achievementId}`);
    expect(page.body).toContain('Intro to Network Defense');
    expect(page.body).toContain('og:image');
    const image = await anonymous(own.image.url512, 'image/*');
    expect(image.headers['cache-control']).toBe('public, max-age=600');
    expect(image.rawPayload.equals(await placeholderPng('held', '512'))).toBe(false);
    const issuerPage = await anonymous(`/issuers/${org.issuerId}`);
    expect(issuerPage.body).toContain('Held Academy');

    // The member's badge was released.
    const [badge] = (await org.owner.get(`${org.api}/credentials`)).json().credentials as {
      id: string;
    }[];
    expect((await anonymous(`/credentials/${badge?.id}`)).statusCode).toBe(200);

    expect((await achievementOf(org, later)).review.text).toBe('pending');
    expect((await itemsOf(org.orgId)).every((item) => item.subject.id === later)).toBe(true);
    const actions = (await auditActions(org.orgId)).map((row) => row.action);
    expect(actions.filter((action) => action === 'moderation.cleared')).toHaveLength(seen.length);
  });

  it('holds edits for review, shows the version cleared last, and limits awards to members', async () => {
    const outsider = `outsider-${randomBytes(3).toString('hex')}@example.org`;
    expect((await award(org, outsider)).statusCode).toBe(201);

    const edited = await org.owner.patch(`${org.api}/achievements/${org.achievementId}`, {
      name: 'Renamed while waiting',
    });
    expect(edited.statusCode).toBe(200);
    expect((await achievementOf(org)).review.text).toBe('pending');
    const page = await anonymous(`/achievements/${org.achievementId}`);
    expect(page.body).toContain('An update is waiting for review');
    expect(page.body).toContain('Intro to Network Defense');
    expect(page.body).not.toContain('Renamed while waiting');

    expectProblem(await award(org, outsider), 409, 'content_in_review');
    const member = await award(org, org.owner.email);
    expect(member.statusCode).toBe(201);
    const memberBadge = (member.json() as { id: string }).id;
    expect((await anonymous(`/credentials/${memberBadge}`)).statusCode).toBe(404);

    // A CSV upload marks everyone but members as not allowed while it waits.
    const csv = await org.owner.upload(
      `${org.api}/batches?achievementId=${org.achievementId}`,
      Buffer.from(`name,email\nSam Taylor,${outsider}\nJordan Rivera,${org.owner.email}\n`),
      'text/csv',
      'POST',
    );
    expect(csv.statusCode, csv.body).toBe(201);
    const report = csv.json() as { counts: { invalid: number } };
    expect(report.counts.invalid).toBe(1);

    // Going back to text that was cleared needs no new review.
    await org.owner.patch(`${org.api}/achievements/${org.achievementId}`, {
      name: 'Intro to Network Defense',
    });
    expect((await achievementOf(org)).review.text).toBe('cleared');
    expect((await award(org, outsider)).statusCode).toBe(201);
    // The member's badge still waits for the renamed version it carries.
    expect((await anonymous(`/credentials/${memberBadge}`)).statusCode).toBe(404);
  });
});

describe('the word list and trusted orgs', () => {
  let org: IssuingOrg;

  beforeAll(async () => {
    org = await issuingOrg(env, 'Trusted Academy');
    const pending = await itemsOf(org.orgId);
    await admin.post(`/api/v1/platform/orgs/${org.orgId}/approve`, {
      clearItemIds: pending.map((item) => item.id),
    });
    const trusted = await admin.post(`/api/v1/platform/orgs/${org.orgId}/trust`, { trusted: true });
    expect(trusted.statusCode).toBe(200);
  });

  it('publishes a trusted org’s new content at once', async () => {
    const id = await publishedAchievement(org.owner, org.api, 'Advanced Network Defense');
    expect((await achievementOf(org, id)).review).toEqual({ text: 'cleared', image: 'cleared' });
    expect((await anonymous(`/achievements/${id}`)).body).toContain('Advanced Network Defense');
    expect((await auditActions(org.orgId)).map((row) => row.action)).toContain('org.trusted');
  });

  it('holds text matching the word list, even for a trusted org, spelled with swaps', async () => {
    const created = await org.owner.post(`${org.api}/achievements`, {
      name: 'Safety basics',
      description: 'Covers the Z0RBL@X protocol and more.',
      criteriaNarrative: 'Pass the quiz.',
    });
    const id = (created.json() as { id: string }).id;
    await org.owner.upload(
      `${org.api}/achievements/${id}/image`,
      Buffer.from(BADGE_SVG),
      'image/svg+xml',
    );
    await org.owner.post(`${org.api}/achievements/${id}/publish`);
    expect((await achievementOf(org, id)).review.text).toBe('pending');
    const item = (await itemsOf(org.orgId)).find((entry) => entry.subject.id === id);
    expect(item?.flags).toEqual([
      expect.objectContaining({ source: 'blocklist', terms: ['zorblax'] }),
    ]);
  });

  it('matches whole-word terms only as words', async () => {
    const innocent = await org.owner.post(`${org.api}/achievements`, {
      name: 'Dangerous goods handling',
      description: 'Handling of dangerous goods.',
      criteriaNarrative: 'Pass the quiz.',
    });
    const flagged = await org.owner.post(`${org.api}/achievements`, {
      name: 'Oh dang',
      description: 'A title with the word.',
      criteriaNarrative: 'Pass the quiz.',
    });
    const status = async (response: { json(): unknown }) => {
      const id = (response.json() as { id: string }).id;
      const [row] = await env.ownerDb.select().from(achievement).where(eq(achievement.id, id));
      const [item] = await env.ownerDb
        .select()
        .from(moderationItem)
        .where(eq(moderationItem.id, row?.textItemId ?? ''));
      return item?.status;
    };
    expect(await status(innocent)).toBe('cleared');
    expect(await status(flagged)).toBe('pending');
  });
});

describe('removing, unpublishing, suspending and revoking', () => {
  let org: IssuingOrg;
  let badge: string;

  /** Artwork of this org only: other suites upload the shared test image. */
  const artwork = Buffer.from(BADGE_SVG.replace('#379392', '#7A2E8C'));

  beforeAll(async () => {
    org = await issuingOrg(env, 'Removal Academy');
    await org.owner.upload(
      `${org.api}/achievements/${org.achievementId}/image`,
      artwork,
      'image/svg+xml',
    );
    await admin.post(`/api/v1/platform/orgs/${org.orgId}/approve`, {
      clearItemIds: (await itemsOf(org.orgId)).map((item) => item.id),
    });
    const awarded = await award(org, 'recipient@example.org');
    badge = (awarded.json() as { id: string }).id;
  });

  it('keeps a removed image’s URL answering with a placeholder, and its badges verifying', async () => {
    const image = await storedImage(org);
    const own = await achievementOf(org);
    const removed = await admin.post(`/api/v1/platform/moderation/items/${image?.id}/remove`, {
      reason: 'Graphic violence in the artwork.',
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((removed.json() as Item).status).toBe('removed');

    const placeholder = await anonymous(own.image.url512, 'image/*');
    expect(placeholder.statusCode).toBe(200);
    expect(placeholder.rawPayload.equals(await placeholderPng('removed', '512'))).toBe(true);
    expect(placeholder.headers['cache-control']).toBe('public, max-age=300');
    const svg = await anonymous(own.image.url, 'image/*');
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.body).not.toContain('#7A2E8C');

    // The badge still checks: by its URL, and as a baked PNG of the placeholder.
    const page = await anonymous(`/credentials/${badge}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Badge image removed');
    expect(page.body).not.toContain('og:image');
    const byUrl = await env.app.inject({
      method: 'POST',
      url: '/api/v1/verify',
      payload: { url: `${BASE_URL}/credentials/${badge}` },
    });
    expect((byUrl.json() as { verified: boolean }).verified).toBe(true);
    const baked = await anonymous(`/credentials/${badge}/badge.png`, 'image/png');
    expect(baked.statusCode).toBe(200);
    expect(extractFromPng(baked.rawPayload)).toBeDefined();
    const byImage = await env.app.inject({
      method: 'POST',
      url: '/api/v1/verify',
      payload: { image: baked.rawPayload.toString('base64') },
    });
    expect((byImage.json() as { verified: boolean }).verified).toBe(true);

    // The owners are told why, with replies going to the abuse address.
    const email = lastEmailTo(env, org.owner.email, 'moderation-removed');
    expect(email.text).toContain('Graphic violence in the artwork.');
    expect(email.replyTo).toBe('abuse@credforge.test');
    expect((await auditActions(org.orgId)).map((row) => row.action)).toContain(
      'moderation.removed',
    );

    // It can't be awarded until it is changed, and the same image uploaded again stays removed.
    expectProblem(await award(org, 'someone@example.org'), 409, 'content_removed');
    const other = await org.owner.post(`${org.api}/achievements`, {
      name: 'Same artwork',
      description: 'Uses the removed image.',
      criteriaNarrative: 'Nothing.',
    });
    const otherId = (other.json() as { id: string }).id;
    await org.owner.upload(`${org.api}/achievements/${otherId}/image`, artwork, 'image/svg+xml');
    expect((await achievementOf(org, otherId)).review.image).toBe('removed');
  });

  it('unpublishes an achievement: 410, no details on its badges, only an admin puts it back', async () => {
    const unpublished = await admin.post(
      `/api/v1/platform/achievements/${org.achievementId}/unpublish`,
      { reason: 'Hateful wording.' },
    );
    expect(unpublished.statusCode, unpublished.body).toBe(200);
    expect((await anonymous(`/achievements/${org.achievementId}`)).statusCode).toBe(410);
    expect(
      (await anonymous(`/achievements/${org.achievementId}`, 'application/json')).statusCode,
    ).toBe(410);
    const page = await anonymous(`/credentials/${badge}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Achievement removed');
    expect(page.body).not.toContain('Intro to Network Defense');
    expect(page.body).not.toContain('Recognizes foundational skills');
    expect((await achievementOf(org)).removed?.reason).toBe('Hateful wording.');
    expectProblem(
      await org.owner.post(`${org.api}/achievements/${org.achievementId}/restore`),
      409,
      'removed_by_platform',
    );
    expect(lastEmailTo(env, org.owner.email, 'achievement-unpublished').text).toContain(
      'Hateful wording.',
    );

    await admin.post(`/api/v1/platform/achievements/${org.achievementId}/reinstate`);
    const restored = await org.owner.post(`${org.api}/achievements/${org.achievementId}/restore`);
    expect(restored.statusCode).toBe(200);
  });

  it('revokes every badge of a suspended org, and only of a suspended one', async () => {
    expectProblem(
      await admin.post(`/api/v1/platform/orgs/${org.orgId}/revoke-credentials`, {
        reason: 'Phishing.',
      }),
      409,
      'conflict',
    );
    await admin.post(`/api/v1/platform/orgs/${org.orgId}/suspend`, { reason: 'Phishing.' });
    expect(lastEmailTo(env, org.owner.email, 'org-suspended').replyTo).toBe('abuse@credforge.test');
    const revoked = await admin.post(`/api/v1/platform/orgs/${org.orgId}/revoke-credentials`, {
      reason: 'Phishing.',
      publicReason: 'Awarded by an organization removed for abuse.',
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((revoked.json() as { revoked: number }).revoked).toBe(1);
    expect((await anonymous(`/credentials/${badge}`)).body).toContain(
      'Awarded by an organization removed for abuse.',
    );
    const actions = (await auditActions(org.orgId)).map((row) => row.action);
    expect(actions).toContain('org.credentials_revoked');
    expect(actions).toContain('credential.revoked');
    expect(lastEmailTo(env, org.owner.email, 'org-credentials-revoked').text).toContain('1 badge');
  });
});

describe('disabling an account', () => {
  it('ends its sessions and refuses sign-in until it is enabled again', async () => {
    const org = await issuingOrg(env, 'Disabled Academy');
    const target = await newUser(env, { name: 'Casey Morgan' });
    const targetId = ((await target.me()) as { user: { id: string } }).user.id;
    const disabled = await admin.post(`/api/v1/platform/users/${targetId}/disable`, {
      reason: 'Uploaded abusive images.',
      orgId: org.orgId,
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect((await target.get('/api/v1/me')).statusCode).toBe(401);
    const signIn = await target.post('/api/auth/sign-in/email', {
      email: target.email,
      password: target.password,
    });
    expect(signIn.statusCode).toBe(403);
    expect(lastEmailTo(env, target.email, 'account-disabled').text).toContain(
      'Uploaded abusive images.',
    );
    expect(lastEmailTo(env, org.owner.email, 'member-disabled').text).toContain(target.email);
    expect((await auditActions(org.orgId)).map((row) => row.action)).toContain('user.disabled');

    const adminId = ((await admin.me()) as { user: { id: string } }).user.id;
    expect(
      (await admin.post(`/api/v1/platform/users/${adminId}/disable`, { reason: 'x' })).statusCode,
    ).toBe(403);

    await admin.post(`/api/v1/platform/users/${targetId}/enable`);
    await target.signIn();
    expect((await target.get('/api/v1/me')).statusCode).toBe(200);
  });
});

describe('reports from public pages', () => {
  let org: IssuingOrg;
  let badge: string;

  beforeAll(async () => {
    org = await issuingOrg(env, 'Reported Academy');
    await admin.post(`/api/v1/platform/orgs/${org.orgId}/approve`, {
      clearItemIds: (await itemsOf(org.orgId)).map((item) => item.id),
    });
    await org.owner.upload(
      `${org.api}/issuers/${org.issuerId}/logo`,
      Buffer.from(BADGE_SVG.replace('#379392', '#CA3CFF')),
      'image/svg+xml',
    );
    for (const item of await itemsOf(org.orgId)) {
      await admin.post(`/api/v1/platform/moderation/items/${item.id}/clear`);
    }
    badge = ((await award(org, 'reported@example.org')).json() as { id: string }).id;
  });

  /** A form token as the page would have made it a few seconds ago. */
  const token = (type: string, id: string, age = 10_000) =>
    reportFormToken(env.config.authSecret, { type, id }, Date.now() - age);

  function send(
    path: string,
    fields: Record<string, string>,
    options: { origin?: string; ip?: string } = {},
  ) {
    return env.app.inject({
      method: 'POST',
      url: path,
      remoteAddress: options.ip ?? '198.51.100.7',
      headers: {
        origin: options.origin ?? BASE_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(fields).toString(),
    });
  }

  const reportCount = async () =>
    (await env.ownerDb.select({ id: contentReport.id }).from(contentReport)).length;

  it('shows the form on its own page and takes a report', async () => {
    const page = await anonymous(`/report/achievement/${org.achievementId}`);
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect(page.body).toContain('Report a problem');
    expect(page.body).toContain('the achievement Intro to Network Defense');

    const before = await reportCount();
    const sent = await send(`/report/achievement/${org.achievementId}`, {
      token: token('achievement', org.achievementId),
      category: 'hate_harassment',
      details: 'Slurs in the description.',
      email: 'Reporter@Example.org',
      website: '',
    });
    expect(sent.statusCode).toBe(303);
    expect(sent.headers.location).toBe(`/report/achievement/${org.achievementId}?sent=1`);
    expect(await reportCount()).toBe(before + 1);
    const thanks = await anonymous(`/report/achievement/${org.achievementId}?sent=1`);
    expect(thanks.body).toContain('your report was sent');
    const email = lastEmailTo(env, admin.email, 'report-received');
    expect(email.text).toContain('Hate, harassment or threats');
    expect(email.text).toContain('Slurs in the description.');
    // Images stay as they were for other categories.
    expect((await storedImage(org))?.status).toBe('cleared');
  });

  it('holds the page’s images at once on a child-safety report, telling the org nothing more', async () => {
    const sent = await send(`/report/credential/${badge}`, {
      token: token('credential', badge),
      category: 'child_safety',
    });
    expect(sent.statusCode).toBe(303);
    // The badge image and the issuer logo it shows are held.
    expect((await storedImage(org))?.status).toBe('pending');
    const [logoRow] = await env.ownerDb
      .select({ fileId: issuer.imageFileId })
      .from(issuer)
      .where(eq(issuer.id, org.issuerId));
    const [logo] = await env.ownerDb
      .select()
      .from(moderationItem)
      .where(eq(moderationItem.fileId, logoRow?.fileId ?? ''));
    expect(logo?.status).toBe('pending');

    const own = await achievementOf(org);
    const image = await anonymous(own.image.url512, 'image/*');
    expect(image.rawPayload.equals(await placeholderPng('held', '512'))).toBe(true);
    expect((await anonymous(`/achievements/${org.achievementId}`)).body).not.toContain(
      own.image.url512,
    );
    expect((await anonymous(`/credentials/${badge}/badge.png`, 'image/png')).statusCode).toBe(409);
    expect(lastEmailTo(env, admin.email, 'report-received').text).toContain('held for review');

    const events = await auditActions(org.orgId);
    const held = events.find((row) => row.action === 'moderation.images_held');
    expect(held).toBeDefined();
    expect(JSON.stringify(events)).not.toContain('child_safety');

    // In the queue, with the report.
    const reports = (await admin.get('/api/v1/platform/reports')).json() as {
      reports: { id: string; category: string; heldItemIds: string[]; items: Item[] }[];
    };
    const report = reports.reports.find((entry) => entry.category === 'child_safety');
    expect(report?.heldItemIds).toHaveLength(2);
    expect(report?.items.length).toBeGreaterThanOrEqual(2);
    const queued = await itemsOf(org.orgId);
    expect(queued.some((item) => item.flags.some((flag) => flag.category === 'child_safety'))).toBe(
      true,
    );

    // Resolving it goes in the instance's log, not the org's.
    const resolved = await admin.post(`/api/v1/platform/reports/${report?.id}/resolve`, {
      status: 'dismissed',
      note: 'Nothing found.',
    });
    expect(resolved.statusCode).toBe(200);
    expect((await auditActions(null)).map((row) => row.action)).toContain('report.dismissed');
    for (const id of report?.heldItemIds ?? []) {
      await admin.post(`/api/v1/platform/moderation/items/${id}/clear`);
    }
    expect((await storedImage(org))?.status).toBe('cleared');
  });

  it('turns bots and stale forms away without a third-party CAPTCHA', async () => {
    const before = await reportCount();
    const path = `/report/issuer/${org.issuerId}`;
    // The hidden field filled in, or sent faster than anyone reads: "sent", nothing stored.
    const honeypot = await send(path, {
      token: token('issuer', org.issuerId),
      category: 'other',
      website: 'http://spam.example',
    });
    expect(honeypot.statusCode).toBe(303);
    const fast = await send(path, { token: token('issuer', org.issuerId, 0), category: 'other' });
    expect(fast.statusCode).toBe(303);
    expect(await reportCount()).toBe(before);
    // A token for another page, an old one, or none: the form again.
    for (const value of [
      token('issuer', org.achievementId),
      token('issuer', org.issuerId, 2 * 24 * 60 * 60 * 1000),
      '',
    ]) {
      const response = await send(path, { token: value, category: 'other' });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('The report wasn’t sent');
    }
    const noCategory = await send(path, { token: token('issuer', org.issuerId) });
    expect(noCategory.statusCode).toBe(400);
    expect(noCategory.body).toContain('Choose what is wrong');
    const badEmail = await send(path, {
      token: token('issuer', org.issuerId),
      category: 'other',
      email: 'not an address',
    });
    expect(badEmail.body).toContain('Enter a valid email address');
    const crossSite = await send(
      path,
      { token: token('issuer', org.issuerId), category: 'other' },
      { origin: 'https://evil.example' },
    );
    expect(crossSite.statusCode).toBe(403);
    expect(await reportCount()).toBe(before);
  });

  it('limits reports per client address', async () => {
    const path = `/report/issuer/${org.issuerId}`;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await send(
        path,
        { token: token('issuer', org.issuerId), category: 'other' },
        { ip: '203.0.113.50' },
      );
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 303)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('offers no form for a page the public can’t see', async () => {
    const hidden = ((await award(org, 'hidden@example.org')).json() as { id: string }).id;
    await env.ownerDb
      .update(credential)
      .set({ visibility: 'hidden' })
      .where(eq(credential.id, hidden));
    expect((await anonymous(`/report/credential/${hidden}`)).statusCode).toBe(404);
    expect((await anonymous('/report/issuer/not-a-uuid')).statusCode).toBe(404);
    expect((await anonymous(`/report/organization/${org.orgId}`)).statusCode).toBe(404);
  });
});

describe('upload limits', () => {
  it('limits uploads per org per hour and the space its files take', async () => {
    const limited = await createTestEnvironment({
      SIGNUP_MODE: 'open',
      ORG_UPLOAD_RATE_LIMIT: '3',
      ORG_STORAGE_QUOTA_MB: '1',
    });
    try {
      const org = await issuingOrg(limited, 'Upload Academy'); // one upload
      const upload = (body: Buffer, type = 'image/svg+xml') =>
        org.owner.upload(`${org.api}/achievements/${org.achievementId}/image`, body, type);
      // Random pixels don't compress: about 1.1 MB as PNG, over the 1 MB quota.
      const noise = await sharp(randomBytes(600 * 600 * 3), {
        raw: { width: 600, height: 600, channels: 3 },
      })
        .png()
        .toBuffer();
      expectProblem(await upload(noise, 'image/png'), 403, 'storage_quota_exceeded');
      expect((await upload(Buffer.from(BADGE_SVG))).statusCode).toBe(200);
      const over = await upload(Buffer.from(BADGE_SVG));
      expectProblem(over, 429, 'rate_limited');
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);

      // A platform admin lifts this org's limits.
      const platform = await newUser(limited, { platformAdmin: true });
      const changed = await platform.patch(`/api/v1/platform/orgs/${org.orgId}/limits`, {
        uploadRateLimit: 0,
        storageQuotaMb: 10,
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect((await upload(noise, 'image/png')).statusCode).toBe(200);
      const listed = (await platform.get('/api/v1/platform/orgs')).json() as {
        orgs: { id: string; storageUsedBytes: number; uploadRateLimit: number | null }[];
      };
      const row = listed.orgs.find((entry) => entry.id === org.orgId);
      expect(row?.uploadRateLimit).toBe(0);
      expect(row?.storageUsedBytes).toBeGreaterThan(1024 * 1024);
    } finally {
      await limited.close();
    }
  });
});

describe('the privacy policy draft', () => {
  it('says whose content is reviewed, that a word list holds text, and what a report keeps', async () => {
    const page = await anonymous('/privacy');
    expect(page.body).toContain('organizations they haven’t marked as trusted');
    expect(page.body).toContain('Text that matches a list of words');
    expect(page.body).toContain('If you report a problem');
    const terms = await anonymous('/terms');
    expect(terms.body).toContain('anything that sexualizes, exploits or endangers children');
  });
});

describe('review modes and the first migration', () => {
  it('holds even a trusted org’s content with MODERATION_REVIEW=all', async () => {
    const strict = await createTestEnvironment({ SIGNUP_MODE: 'open', MODERATION_REVIEW: 'all' });
    try {
      const org = await issuingOrg(strict, 'Strict Academy');
      await strict.ownerDb
        .update(organization)
        .set({ trustedAt: new Date() })
        .where(eq(organization.id, org.orgId));
      const id = await publishedAchievement(org.owner, org.api, 'Strictly reviewed');
      const own = (await org.owner.get(`${org.api}/achievements/${id}`)).json() as {
        review: { text: string };
      };
      expect(own.review.text).toBe('pending');
    } finally {
      await strict.close();
    }
  });

  it('gives content published before moderation cleared items, once', async () => {
    const old = await createTestEnvironment({
      SIGNUP_MODE: 'open',
      MODERATION_REVIEW: 'untrusted',
    });
    try {
      const org = await issuingOrg(old, 'Earlier Academy');
      const draft = await org.owner.post(`${org.api}/achievements`, {
        name: 'Older draft',
        description: 'Never published.',
        criteriaNarrative: 'Nothing.',
      });
      const draftId = (draft.json() as { id: string }).id;
      // As the database looked before migration 0008: no items, no pointers.
      await old.ownerDb.update(achievement).set({ textItemId: null });
      await old.ownerDb.update(issuer).set({ textItemId: null });
      await old.ownerDb.update(organization).set({ nameItemId: null });
      await old.ownerDb.delete(moderationItem);
      await old.ownerDb
        .delete(instanceSettings)
        .where(eq(instanceSettings.key, MODERATION_BACKFILLED));

      const written = await backfillModerationItems(old.ownerDb, old.config.moderation);
      expect(written).toBeGreaterThanOrEqual(5);
      expect(await backfillModerationItems(old.ownerDb, old.config.moderation)).toBeNull();

      const page = await old.app.inject({
        method: 'GET',
        url: `/achievements/${org.achievementId}`,
        headers: { accept: 'text/html' },
      });
      expect(page.body).toContain('Intro to Network Defense');
      const own = (await org.owner.get(`${org.api}/achievements/${org.achievementId}`)).json() as {
        review: { text: string; image: string };
      };
      expect(own.review).toEqual({ text: 'cleared', image: 'cleared' });
      const draftReview = (await org.owner.get(`${org.api}/achievements/${draftId}`)).json() as {
        review: { text: string };
      };
      expect(draftReview.review.text).toBe('pending');
    } finally {
      await old.close();
    }
  });
});
