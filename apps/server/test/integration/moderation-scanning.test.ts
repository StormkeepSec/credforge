import { execFile } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  and,
  auditEvent,
  eq,
  file,
  moderationEvidence,
  moderationItem,
  organization,
  session,
  user,
} from '@credforge/db';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryJobQueue } from '../../src/jobs/enqueue';
import { CSAM_SUSPENSION_REASON } from '../../src/moderation/csam';
import { openEvidence } from '../../src/moderation/evidence';
import { placeholderPng } from '../../src/moderation/placeholders';
import {
  checkWaitingItems,
  MAX_SCAN_ATTEMPTS,
  type ScanDependencies,
  type ScanOutcome,
  scanItem,
  scansToResume,
} from '../../src/moderation/scan';
import { type CategoryScores, ScanError, type Scanners } from '../../src/moderation/scanners';
import { expectProblem, lastEmailTo, newUser, type TestClient } from './support/client';
import { createTestEnvironment, type TestEnvironment } from './support/harness';
import { type IssuingOrg, issuingOrg } from './support/issuing';

/**
 * The automatic check and known-CSAM matching (design plan §6.5, decisions 60–61): nothing is
 * published before its check; scores over the operator's thresholds hold or remove content; a
 * check that keeps failing waits for a person; a known-CSAM match is never served or shown to
 * anyone, its org is suspended and its evidence sealed where the app can't read it back. The
 * scanners here are stand-ins, and the thresholds and key made up: credforge ships none.
 */

let env: TestEnvironment;
let admin: TestClient;
let deps: ScanDependencies;
let privateKey: KeyObject;
let keyFile: string;
const jobs = createMemoryJobQueue();

/** What the stand-in scanners answer, and what they were sent. */
const fake = {
  image: {} as CategoryScores,
  text: {} as CategoryScores,
  /** Image hashes the matcher "finds" in its lists. */
  known: new Set<string>(),
  failures: 0,
  calls: { image: 0, text: 0, match: [] as string[] },
};

const scanners: Scanners = {
  image: {
    name: 'Test classifier',
    async scanImage() {
      fake.calls.image++;
      if (fake.failures > 0) {
        fake.failures--;
        throw new ScanError('Test classifier answered 503.');
      }
      return fake.image;
    },
  },
  text: {
    name: 'Test classifier',
    async scanText() {
      fake.calls.text++;
      if (fake.failures > 0) {
        fake.failures--;
        throw new ScanError('Test classifier answered 503.');
      }
      return fake.text;
    },
  },
  csam: {
    name: 'Test matcher',
    async match(image) {
      fake.calls.match.push(image.sha256);
      return fake.known.has(image.sha256) ? { list: 'Test list', reference: 'ref-42' } : null;
    },
  },
};

async function waiting(orgId: string) {
  return env.ownerDb
    .select()
    .from(moderationItem)
    .where(and(eq(moderationItem.orgId, orgId), eq(moderationItem.scanStatus, 'waiting')));
}

/** Runs every waiting check of an org, as the worker would; outcomes by kind. */
async function scanOrg(orgId: string): Promise<Record<string, ScanOutcome>> {
  const outcomes: Record<string, ScanOutcome> = {};
  for (const item of await waiting(orgId)) outcomes[item.kind] = await scanItem(deps, item.id);
  return outcomes;
}

async function itemById(id: string) {
  const [row] = await env.ownerDb.select().from(moderationItem).where(eq(moderationItem.id, id));
  if (!row) throw new Error('no item');
  return row;
}

/** A distinct PNG: its own content hash, so its own known-CSAM verdict. */
async function png(color: string): Promise<Buffer> {
  return sharp({ create: { width: 96, height: 96, channels: 4, background: color } })
    .png()
    .toBuffer();
}

/** Uploads a badge image and returns its moderation item, file and public 512 px URL. */
async function uploadBadge(org: IssuingOrg, bytes: Buffer) {
  const response = await org.owner.upload(
    `${org.api}/achievements/${org.achievementId}/image`,
    bytes,
    'image/png',
  );
  expect(response.statusCode, response.body).toBe(200);
  const url512 = (response.json() as { image: { url512: string } }).image.url512;
  const sha256 = /\/([0-9a-f]{64})-512\.png$/.exec(url512)?.[1] ?? '';
  const [row] = await env.ownerDb
    .select({ item: moderationItem, file })
    .from(file)
    .innerJoin(moderationItem, eq(moderationItem.fileId, file.id))
    .where(and(eq(file.subjectId, org.achievementId), eq(file.sha256, sha256)));
  if (!row) throw new Error('no image item');
  return { ...row, url: new URL(url512).pathname };
}

async function get(url: string, client?: TestClient) {
  if (client) return client.get(url);
  return env.app.inject({ method: 'GET', url });
}

async function heldTile() {
  return placeholderPng('held', '512');
}

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
  privateKey = pair.privateKey;
  keyFile = join(mkdtempSync(join(tmpdir(), 'credforge-evidence-key-')), 'evidence-key.pem');
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  env = await createTestEnvironment(
    {
      // Only the automatic check holds content here (and the word list, in one test).
      MODERATION_REVIEW: 'off',
      MODERATION_TEXT_BLOCKLIST: 'zorblax',
      MODERATION_PROVIDER: 'webhook',
      MODERATION_WEBHOOK_URL: 'https://scanner.example.org/check',
      MODERATION_WEBHOOK_SECRET: 'test-webhook-secret-0123456789abcdef',
      MODERATION_WEBHOOK_NAME: 'Test classifier',
      MODERATION_HOLD_THRESHOLD: '0.5',
      MODERATION_REMOVE_THRESHOLD: '0.9',
      MODERATION_CATEGORY_THRESHOLDS: 'sexual/minors=0.1:0.5',
      CSAM_MATCHER: 'webhook',
      CSAM_MATCHER_URL: 'https://matcher.example.org/match',
      CSAM_MATCHER_SECRET: 'test-matcher-secret-0123456789abcdef',
      CSAM_MATCHER_NAME: 'Test matcher',
      CSAM_EVIDENCE_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      ABUSE_EMAIL: 'abuse@credforge.test',
      ORG_UPLOAD_RATE_LIMIT: '100',
    },
    // The CLI test sends its emails through the job queue.
    { queue: true },
  );
  deps = {
    db: env.db,
    config: env.config,
    storage: env.storage,
    outbox: env.outbox,
    scanners,
    jobs,
  };
  admin = await newUser(env, { name: 'Platform Admin', platformAdmin: true });
}, 120_000);

afterAll(async () => {
  await env?.close();
});

describe('the automatic check', () => {
  let org: IssuingOrg;

  beforeAll(async () => {
    org = await issuingOrg(env, 'Checked Academy');
  });

  it('publishes nothing before it has run, and publishes what scores under the thresholds', async () => {
    fake.image = { sexual: 0.02, violence: 0.1 };
    fake.text = { hate: 0.01 };
    const image = await uploadBadge(org, await png('#2a9d8f'));
    expect(image.item).toMatchObject({ status: 'pending', scanStatus: 'waiting' });
    const text = (await waiting(org.orgId)).find((row) => row.kind === 'text');
    expect(text?.status).toBe('pending');

    // Not public; not even the org's own members see an image the matcher hasn't checked.
    for (const client of [undefined, org.owner]) {
      const tile = await get(image.url, client);
      expect(tile.headers['cache-control']).toBe('no-store');
      expect(tile.rawPayload.equals(await heldTile())).toBe(true);
    }
    const page = await get(`/achievements/${org.achievementId}`);
    expect(page.body).not.toContain('Intro to Network Defense');
    // Platform admins neither see it in the queue, nor its image, nor can they clear it yet.
    const queue = (await admin.get(`/api/v1/platform/moderation/items?orgId=${org.orgId}`)).json();
    expect(queue.items).toEqual([]);
    await expectProblem(
      await admin.get(`/api/v1/platform/moderation/items/${image.item.id}/image`),
      409,
      'conflict',
    );
    await expectProblem(
      await admin.post(`/api/v1/platform/moderation/items/${image.item.id}/clear`, {}),
      409,
      'conflict',
    );
    const summary = (await admin.get('/api/v1/platform/moderation/summary')).json();
    expect(summary.scanning).toMatchObject({
      provider: 'Test classifier',
      images: true,
      text: true,
      csamMatcher: 'Test matcher',
    });
    expect(summary.scanning.waiting).toBeGreaterThanOrEqual(2);

    const outcomes = await scanOrg(org.orgId);
    expect(outcomes).toEqual({ image: 'cleared', text: 'cleared' });
    // The matcher saw the image (by its stored hash) before the classifier did.
    expect(fake.calls.match).toContain(image.file.sha256);
    const checked = await itemById(image.item.id);
    expect(checked).toMatchObject({ status: 'cleared', scanStatus: 'done', decidedBy: null });
    expect(checked.scanResult?.hashCheck).toMatchObject({
      matcher: 'Test matcher',
      matched: false,
    });
    expect(checked.scanResult?.classifier?.scores).toEqual(fake.image);

    const served = await get(image.url);
    expect(served.headers['cache-control']).toBe('public, max-age=600');
    const stored = await env.storage.get(image.file.variants['512']?.key ?? '');
    expect(served.rawPayload.equals(stored as Buffer)).toBe(true);
    expect((await get(`/achievements/${org.achievementId}`)).body).toContain(
      'Intro to Network Defense',
    );
  });

  it('holds content over a hold threshold for a platform admin, with its scores', async () => {
    fake.text = { hate: 0.72, harassment: 0.31 };
    const changed = await org.owner.patch(`${org.api}/achievements/${org.achievementId}`, {
      description: 'An edited description to check.',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const [text] = await waiting(org.orgId);
    expect(await scanItem(deps, text?.id ?? '')).toBe('held');

    const queue = (await admin.get(`/api/v1/platform/moderation/items?orgId=${org.orgId}`)).json();
    const item = queue.items.find((entry: { id: string }) => entry.id === text?.id);
    expect(item.flags).toEqual([
      expect.objectContaining({
        source: 'scan',
        provider: 'Test classifier',
        scores: [{ category: 'hate', score: 0.72 }],
      }),
    ]);
    expect(item.scan).toMatchObject({
      status: 'done',
      provider: 'Test classifier',
      scores: [
        { category: 'hate', score: 0.72 },
        { category: 'harassment', score: 0.31 },
      ],
      error: null,
    });
    // The page keeps the version cleared last meanwhile.
    expect((await get(`/achievements/${org.achievementId}`)).body).not.toContain('An edited');
    const cleared = await admin.post(`/api/v1/platform/moderation/items/${text?.id}/clear`, {});
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await get(`/achievements/${org.achievementId}`)).body).toContain('An edited');
  });

  it('removes content over a remove threshold at once, as the remove action does', async () => {
    fake.image = { sexual: 0.95, violence: 0.2 };
    const image = await uploadBadge(org, await png('#e76f51'));
    expect(await scanItem(deps, image.item.id)).toBe('removed');
    const removed = await itemById(image.item.id);
    expect(removed.status).toBe('removed');
    expect(removed.decisionNote).toBe(
      'Removed by the automatic check (Test classifier): sexual 0.95.',
    );
    const [event] = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(
        and(eq(auditEvent.action, 'moderation.removed'), eq(auditEvent.targetId, image.item.id)),
      );
    expect(event).toMatchObject({ actorType: 'system', actorLabel: 'automatic check' });
    expect(event?.data).toMatchObject({ automatic: true, reason: removed.decisionNote });
    expect(lastEmailTo(env, org.owner.email, 'moderation-removed').text).toContain('sexual 0.95');
    const tile = await get(image.url);
    expect(tile.rawPayload.equals(await placeholderPng('removed', '512'))).toBe(true);

    // A category's own thresholds: held at 0.1, removed at 0.5.
    fake.image = { 'sexual/minors': 0.2 };
    const held = await uploadBadge(org, await png('#264653'));
    expect(await scanItem(deps, held.item.id)).toBe('held');
    fake.image = { 'sexual/minors': 0.55 };
    const gone = await uploadBadge(org, await png('#f4a261'));
    expect(await scanItem(deps, gone.item.id)).toBe('removed');
  });

  it('leaves content the word list holds for a person, even when the check finds nothing', async () => {
    fake.text = { hate: 0.01 };
    await org.owner.patch(`${org.api}/achievements/${org.achievementId}`, {
      description: 'Now with zorblax in it.',
    });
    const [text] = await waiting(org.orgId);
    expect(await scanItem(deps, text?.id ?? '')).toBe('waiting');
    expect(await itemById(text?.id ?? '')).toMatchObject({ status: 'pending', scanStatus: 'done' });
  });

  it('gives up after its last attempt, leaves the item to a person, and can run again', async () => {
    fake.failures = 99;
    await org.owner.patch(`${org.api}/achievements/${org.achievementId}`, {
      description: 'A description the scanner can’t check.',
    });
    const [text] = await waiting(org.orgId);
    const id = text?.id ?? '';
    for (let attempt = 1; attempt < MAX_SCAN_ATTEMPTS; attempt++) {
      await expect(scanItem(deps, id)).rejects.toBeInstanceOf(ScanError);
    }
    expect(await scanItem(deps, id)).toBe('failed');
    const failed = await itemById(id);
    expect(failed).toMatchObject({ status: 'pending', scanStatus: 'failed', scanAttempts: 5 });
    expect(failed.scanResult?.error).toBe('Test classifier answered 503.');

    const queue = (await admin.get(`/api/v1/platform/moderation/items?orgId=${org.orgId}`)).json();
    const item = queue.items.find((entry: { id: string }) => entry.id === id);
    expect(item.scan).toMatchObject({ status: 'failed', error: 'Test classifier answered 503.' });

    fake.failures = 0;
    const again = await admin.post(`/api/v1/platform/moderation/items/${id}/recheck`, {});
    expect(again.statusCode, again.body).toBe(200);
    // Asked for at once where the app has a job queue (here the sweep would find it).
    expect(again.json().scan.status).toBe('waiting');
    await expectProblem(
      await admin.post(`/api/v1/platform/moderation/items/${id}/recheck`, {}),
      409,
      'conflict',
    );
    expect(await scanItem(deps, id)).toBe('cleared');
  });

  it('keeps a passed hash check when the classifier fails, so the matcher isn’t asked again', async () => {
    fake.image = {};
    fake.failures = 1;
    const image = await uploadBadge(org, await png('#606c38'));
    await expect(scanItem(deps, image.item.id)).rejects.toBeInstanceOf(ScanError);
    const failed = await itemById(image.item.id);
    expect(failed.scanResult).toMatchObject({
      hashCheck: { matched: false },
      error: 'Test classifier answered 503.',
    });
    const asked = fake.calls.match.filter((sha) => sha === image.file.sha256).length;
    expect(await scanItem(deps, image.item.id)).toBe('cleared');
    expect(fake.calls.match.filter((sha) => sha === image.file.sha256)).toHaveLength(asked);
    expect((await itemById(image.item.id)).scanResult?.error).toBeUndefined();
  });

  it('finishes checks still waiting after the operator turned scanning off', async () => {
    await org.owner.patch(`${org.api}/achievements/${org.achievementId}`, {
      description: 'Saved just before scanning was turned off.',
    });
    const [text] = await waiting(org.orgId);
    // The worker with no scanner set up: the item is published as the review policy says.
    expect(await scanItem({ ...deps, scanners: {} }, text?.id ?? '')).toBe('cleared');
    expect(await itemById(text?.id ?? '')).toMatchObject({ status: 'cleared', scanStatus: 'done' });
  });

  it('is found again by the sweep when its job was lost, and runs on items already waiting', async () => {
    fake.text = {};
    await org.owner.patch(`${org.api}/achievements/${org.achievementId}`, {
      description: 'Saved while the job queue was down.',
    });
    const [text] = await waiting(org.orgId);
    expect(await scansToResume(env.db)).not.toContain(text?.id);
    await env.ownerDb
      .update(moderationItem)
      .set({ updatedAt: new Date(Date.now() - 120_000) })
      .where(eq(moderationItem.id, text?.id ?? ''));
    expect(await scansToResume(env.db)).toContain(text?.id);

    // An item that waited for a person before scanning was set up gets its check too.
    await env.ownerDb
      .update(moderationItem)
      .set({ scanStatus: null })
      .where(eq(moderationItem.id, text?.id ?? ''));
    expect(await checkWaitingItems(env.db, env.config.moderation.scan)).toContain(text?.id);
    expect((await itemById(text?.id ?? '')).scanStatus).toBe('waiting');
    expect(await scanItem(deps, text?.id ?? '')).toBe('cleared');
  });
});

describe('known child sexual abuse material', () => {
  it('is blocked at once, never served or shown, and its org suspended', async () => {
    fake.image = {};
    fake.text = {};
    const earlier = await issuingOrg(env, 'Earlier Upload Org');
    const org = await issuingOrg(env, 'Matched Org');
    await scanOrg(earlier.orgId);
    await scanOrg(org.orgId);
    const bytes = await png('#8b1e3f');

    // Uploaded first where it wasn't known yet: checked and published.
    fake.image = {};
    const before = await uploadBadge(earlier, bytes);
    expect(await scanItem(deps, before.item.id)).toBe('cleared');

    fake.known.add(before.file.sha256);
    const image = await uploadBadge(org, bytes);
    const original = await env.storage.get(image.file.key);
    const keys = [image.file.key, ...Object.values(image.file.variants).map((v) => v.key)];

    const classified = fake.calls.image;
    expect(await scanItem(deps, image.item.id)).toBe('blocked');
    // Sent nowhere after the match: the classifier never saw it.
    expect(fake.calls.image).toBe(classified);

    const blocked = await itemById(image.item.id);
    expect(blocked).toMatchObject({ status: 'removed', scanStatus: 'done', decidedBy: null });
    const flag = blocked.flags.find((entry) => entry.source === 'hash_match');
    expect(flag).toMatchObject({ matcher: 'Test matcher' });
    const evidenceId = flag?.source === 'hash_match' ? flag.evidenceId : '';

    // The stored objects are gone: the sealed evidence is the only copy.
    for (const key of keys) expect(await env.storage.get(key), key).toBeNull();
    // Every URL of it answers the "Image removed" tile, to everyone, its own members too.
    const removedTile = await placeholderPng('removed', '512');
    for (const client of [undefined, org.owner, admin]) {
      expect((await get(image.url, client)).rawPayload.equals(removedTile)).toBe(true);
    }
    for (const name of ['.png', '-128.png', '-og.png']) {
      const other = await get(image.url.replace('-512.png', name));
      expect(other.statusCode).toBe(200);
      expect(other.headers['content-type']).toBe('image/png');
    }

    // Platform admins never see it, not even blurred, and can't put it back.
    for (const view of ['blurred', 'full']) {
      await expectProblem(
        await admin.get(`/api/v1/platform/moderation/items/${image.item.id}/image?view=${view}`),
        403,
        'forbidden',
      );
    }
    await expectProblem(
      await admin.post(`/api/v1/platform/moderation/items/${image.item.id}/clear`, {}),
      403,
      'forbidden',
    );
    const removed = (
      await admin.get(`/api/v1/platform/moderation/items?status=removed&orgId=${org.orgId}`)
    ).json();
    const shown = removed.items.find((entry: { id: string }) => entry.id === image.item.id);
    expect(shown).toMatchObject({ withheld: 'known_csam', evidenceId });

    // The org is suspended and the uploader disabled, with neutral reasons.
    const [orgRow] = await env.ownerDb
      .select()
      .from(organization)
      .where(eq(organization.id, org.orgId));
    expect(orgRow).toMatchObject({ status: 'suspended', statusReason: CSAM_SUSPENSION_REASON });
    const [uploader] = await env.ownerDb.select().from(user).where(eq(user.email, org.owner.email));
    expect(uploader?.disabledAt).not.toBeNull();
    expect(
      await env.ownerDb
        .select()
        .from(session)
        .where(eq(session.userId, uploader?.id ?? '')),
    ).toEqual([]);
    expect(lastEmailTo(env, admin.email, 'known-csam-blocked').text).toContain(evidenceId);
    expect(lastEmailTo(env, org.owner.email, 'org-suspended').text).not.toMatch(
      /csam|abuse material/i,
    );
    expect(lastEmailTo(env, org.owner.email, 'account-disabled').text).not.toMatch(
      /csam|abuse material/i,
    );
    expect(() => lastEmailTo(env, org.owner.email, 'moderation-removed')).toThrow();

    // The org's own log says what was done; only the instance's log says what matched.
    const orgLog = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.orgId, org.orgId));
    expect(orgLog.map((event) => event.action)).toEqual(
      expect.arrayContaining(['moderation.removed', 'org.suspended', 'user.disabled']),
    );
    expect(JSON.stringify(orgLog)).not.toMatch(/csam|Test matcher|abuse material/i);
    const [instanceEvent] = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, 'moderation.known_csam_blocked'));
    expect(instanceEvent).toMatchObject({ orgId: null, targetId: image.item.id });
    expect(instanceEvent?.data).toMatchObject({
      evidenceId,
      list: 'Test list',
      reference: 'ref-42',
    });

    // The copy published before it was known is checked again, and blocked too.
    const again = await itemById(before.item.id);
    expect(again.scanStatus).toBe('waiting');
    expect(jobs.scans).toContain(before.item.id);
    expect(await scanItem(deps, before.item.id)).toBe('blocked');
    expect((await get(before.url)).rawPayload.equals(removedTile)).toBe(true);
    const [earlierOrg] = await env.ownerDb
      .select({ status: organization.status })
      .from(organization)
      .where(eq(organization.id, earlier.orgId));
    expect(earlierOrg?.status).toBe('suspended');

    // The evidence: sealed, readable only with the private key, and out of the app's reach.
    const [evidence] = await env.ownerDb
      .select()
      .from(moderationEvidence)
      .where(eq(moderationEvidence.id, evidenceId));
    expect(evidence).toMatchObject({
      itemId: image.item.id,
      source: 'matcher',
      matcher: 'Test matcher',
    });
    const envelope = evidence?.envelope.toString('utf8') ?? '';
    expect(envelope).not.toContain((original as Buffer).toString('base64'));
    expect(envelope).not.toContain(org.owner.email);
    const opened = openEvidence(privateKey, evidence?.envelope as Buffer);
    expect(opened.files[0]?.name).toBe('original.png');
    expect(opened.files[0]?.bytes.equals(original as Buffer)).toBe(true);
    expect(opened.manifest).toMatchObject({
      evidenceId,
      detection: {
        source: 'matcher',
        matcher: 'Test matcher',
        list: 'Test list',
        reference: 'ref-42',
      },
      content: { sha256: image.file.sha256, itemId: image.item.id },
      organization: { id: org.orgId, name: 'Matched Org' },
      uploader: { email: org.owner.email },
    });
    expect((opened.manifest.uploadEvents as { action: string }[])[0]?.action).toBe(
      'achievement.image_changed',
    );

    // The app's database role can append evidence and read its plain columns, nothing more.
    const plain = await env.appPool.query(
      'select id, matcher from moderation_evidence where id = $1',
      [evidenceId],
    );
    expect(plain.rows).toHaveLength(1);
    for (const statement of [
      'select envelope from moderation_evidence',
      'select * from moderation_evidence',
      `update moderation_evidence set matcher = 'x'`,
      'delete from moderation_evidence',
    ]) {
      await expect(env.appPool.query(statement), statement).rejects.toMatchObject({
        code: '42501',
      });
    }
    // Not even the owner can change it.
    await expect(
      env.ownerPool.query(`update moderation_evidence set matcher = 'x' where id = $1`, [
        evidenceId,
      ]),
    ).rejects.toThrow('never changed');

    // The same bytes uploaded again, anywhere, are blocked again: another incident, more evidence.
    const third = await issuingOrg(env, 'Third Org');
    await scanOrg(third.orgId);
    const retry = await uploadBadge(third, bytes);
    expect(retry.item.status).toBe('removed');
    expect(await scanItem(deps, retry.item.id)).toBe('blocked');
    expect(
      await env.ownerDb
        .select({ id: moderationEvidence.id })
        .from(moderationEvidence)
        .where(eq(moderationEvidence.contentSha256, image.file.sha256)),
    ).toHaveLength(3);
  });
});

describe('cli.js block-known-csam, export-evidence and open-evidence', () => {
  const SERVER_DIR = resolve(import.meta.dirname, '../..');

  async function cli(...args: string[]) {
    try {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', ...args],
        {
          cwd: SERVER_DIR,
          env: { ...process.env, ...env.processEnv },
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  }

  it('blocks an image found outside credforge, and exports and opens its evidence', async () => {
    fake.image = {};
    fake.text = {};
    const org = await issuingOrg(env, 'Reported Elsewhere Org');
    await scanOrg(org.orgId);
    fake.image = {};
    const image = await uploadBadge(org, await png('#3d405b'));
    expect(await scanItem(deps, image.item.id)).toBe('cleared');
    const original = await env.storage.get(image.file.key);
    const url = `${env.config.publicBaseUrl}${image.url}`;

    const dry = await cli(
      'block-known-csam',
      '--image-url',
      url,
      '--source',
      'Cloudflare CSAM Scanning Tool',
    );
    expect(dry.code).toBe(1);
    expect(dry.stdout).toContain('1 copy of it would be blocked');
    expect((await itemById(image.item.id)).status).toBe('cleared');

    const done = await cli(
      'block-known-csam',
      '--image-url',
      url,
      '--source',
      'Cloudflare CSAM Scanning Tool',
      '--reference',
      'cf-123',
      '--yes',
    );
    expect(done.code, done.stderr).toBe(0);
    const blocked = await itemById(image.item.id);
    expect(blocked.status).toBe('removed');
    const [evidence] = await env.ownerDb
      .select({ id: moderationEvidence.id, source: moderationEvidence.source })
      .from(moderationEvidence)
      .where(eq(moderationEvidence.itemId, image.item.id));
    expect(evidence).toMatchObject({ source: 'operator' });
    expect(done.stdout).toContain(`evidence ${evidence?.id}`);
    expect(await env.storage.get(image.file.key)).toBeNull();
    // Its notices went out through the job queue.
    const emails = await env.ownerPool.query(
      `select data->>'kind' as kind from pgboss.job where name = 'email.send' and data->>'to' = $1`,
      [org.owner.email],
    );
    expect(emails.rows.map((row) => row.kind)).toEqual(
      expect.arrayContaining(['org-suspended', 'account-disabled']),
    );

    const exported = await cli('export-evidence', '--id', evidence?.id ?? '');
    expect(exported.code, exported.stderr).toBe(0);
    expect(exported.stderr).toContain(`Exported evidence ${evidence?.id}`);
    const [exportEvent] = await env.ownerDb
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, 'moderation.evidence_exported'));
    expect(exportEvent).toMatchObject({ orgId: null, targetId: evidence?.id });

    const folder = mkdtempSync(join(tmpdir(), 'credforge-opened-'));
    const input = join(folder, 'evidence.json');
    writeFileSync(input, exported.stdout);
    const out = join(folder, 'case');
    const opened = await cli('open-evidence', '--key', keyFile, '--in', input, '--out', out);
    expect(opened.code, opened.stderr).toBe(0);
    expect(readFileSync(join(out, 'original.png')).equals(original as Buffer)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.detection).toEqual({
      source: 'operator',
      matcher: 'Cloudflare CSAM Scanning Tool',
      list: null,
      reference: 'cf-123',
    });
    // Never into a folder that has something in it.
    expect((await cli('open-evidence', '--key', keyFile, '--in', input, '--out', out)).code).toBe(
      1,
    );
  }, 120_000);
});

describe('the privacy policy', () => {
  it('names the scanner and the known-CSAM matcher content is sent to', async () => {
    const page = await env.app.inject({ method: 'GET', url: '/privacy' });
    expect(page.statusCode).toBe(200);
    const text = page.body.replace(/<[^>]+>/g, '');
    expect(text).toContain(
      'Test classifier checks the images and public text organizations publish',
    );
    expect(text).toContain(
      'Test matcher compares uploaded images with lists of known child sexual abuse material',
    );
    expect(text).toContain('removed at once');
    expect(text).toContain('Evidence of child sexual abuse material');
    const terms = await env.app.inject({ method: 'GET', url: '/terms' });
    expect(terms.body).toContain('matches known child sexual abuse material is blocked at once');
  });
});
