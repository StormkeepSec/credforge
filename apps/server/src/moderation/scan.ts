import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  type Database,
  eq,
  file,
  inArray,
  isNull,
  lt,
  type ModerationFlag,
  moderationItem,
  or,
  type ScanResult,
  sql,
} from '@credforge/db';
import { type AuditActor, recordAudit } from '../audit/audit';
import type { Config } from '../config';
import { contentRemovedMessage } from '../email/messages';
import type { EmailOutbox } from '../email/outbox';
import type { FileRow } from '../files/service';
import type { Storage } from '../files/storage';
import type { JobQueue } from '../jobs/enqueue';
import { ownerEmails } from '../orgs/service';
import { blockKnownCsam, finishBlock, sameImageItems } from './csam';
import { describeItem, textFields } from './queue';
import { createOpenAiModerator } from './scan-openai';
import { createWebhookCsamMatcher, createWebhookModerator } from './scan-webhook';
import {
  type CategoryScores,
  type MatchImage,
  type ScanContext,
  ScanError,
  type ScanImage,
  type Scanners,
} from './scanners';
import { decideItems, isHashMatched, type ModerationItemRow } from './service';
import { decide } from './thresholds';

/**
 * The automatic check (design plan §6.5, decision 60), run by the worker on every new image and
 * public text while a scanner is set up. Until it has run, the item is pending (nothing is
 * published). Images go to the known-CSAM matcher first: a match blocks the image and keeps it as
 * evidence (`csam.ts`), and it is sent nowhere else. Then the classifier scores the image or text,
 * and the operator's thresholds decide: under every hold threshold the item is published (or keeps
 * waiting for a platform admin when the review policy, the word list or a report holds it), at or
 * over one it is held for a platform admin with its scores, at or over a remove threshold it is
 * removed at once. A check that keeps failing leaves the item for a person.
 */

/** Attempts before a check is given up and the item left for a platform admin. */
export const MAX_SCAN_ATTEMPTS = 5;
/** The actor of what the check decides, in the org's audit log. */
export const SCAN_ACTOR: AuditActor = { type: 'system', label: 'automatic check' };

export interface ScanDependencies {
  db: Database;
  config: Pick<Config, 'publicBaseUrl' | 'abuseEmail' | 'moderation'>;
  storage: Storage;
  outbox: EmailOutbox;
  scanners: Scanners;
  /** To re-check other items with the same bytes as a match. */
  jobs?: Pick<JobQueue, 'scanContent'>;
}

/** The scanners the configuration sets up. */
export function createScanners(
  config: Pick<Config, 'publicBaseUrl' | 'moderation'>,
  options: { fetch?: typeof fetch } = {},
): Scanners {
  const userAgent = `credforge (+${config.publicBaseUrl})`;
  const { scanner, csamMatcher } = config.moderation;
  const scanners: Scanners = {};
  if (scanner.provider === 'webhook') {
    const moderator = createWebhookModerator(scanner, { userAgent, fetch: options.fetch });
    if (scanner.images) scanners.image = moderator;
    if (scanner.text) scanners.text = moderator;
  } else if (scanner.provider === 'openai') {
    const moderator = createOpenAiModerator({
      apiKey: scanner.apiKey,
      model: scanner.model,
      userAgent,
      fetch: options.fetch,
    });
    if (scanner.images) scanners.image = moderator;
    if (scanner.text) scanners.text = moderator;
  }
  if (csamMatcher.kind === 'webhook') {
    scanners.csam = createWebhookCsamMatcher(csamMatcher, { userAgent, fetch: options.fetch });
  }
  return scanners;
}

export type ScanOutcome =
  /** Not waiting for a check (done already, or gone). */
  | 'skipped'
  /** Published. */
  | 'cleared'
  /** Held for a platform admin by its scores. */
  | 'held'
  /** Nothing found, but it waits for a platform admin anyway (review policy, word list, report). */
  | 'waiting'
  /** A platform admin decided while it waited (or it was removed before): only recorded. */
  | 'recorded'
  /** Removed at once by its scores. */
  | 'removed'
  /** Matched known CSAM. */
  | 'blocked'
  /** Given up after its last attempt: it waits for a platform admin. */
  | 'failed';

function subjectOf(item: ModerationItemRow): ScanContext['subject'] {
  if (item.kind === 'image')
    return item.subjectType === 'achievement' ? 'badge_image' : 'issuer_logo';
  return item.subjectType;
}

async function object(storage: Storage, key: string | undefined): Promise<Buffer> {
  const bytes = key ? await storage.get(key) : null;
  if (!bytes) throw new ScanError('The image’s stored file is missing.');
  return bytes;
}

/** The 512 px PNG every image has: what people see, and never an SVG. */
async function scanImageOf(storage: Storage, row: FileRow): Promise<ScanImage> {
  const variant = row.variants['512'];
  return {
    png: await object(storage, variant?.key),
    width: variant?.width ?? 512,
    height: variant?.height ?? 512,
  };
}

/** For the matcher: the stored original when it is a PNG (every raster upload is), else the 512. */
async function matchImageOf(storage: Storage, row: FileRow): Promise<MatchImage> {
  if (row.mimeType === 'image/png') {
    return {
      bytes: await object(storage, row.key),
      mimeType: 'image/png',
      width: row.width ?? 0,
      height: row.height ?? 0,
      sha256: row.sha256,
    };
  }
  const image = await scanImageOf(storage, row);
  return {
    bytes: image.png,
    mimeType: 'image/png',
    width: image.width,
    height: image.height,
    sha256: row.sha256,
  };
}

/**
 * Runs an item's check. Returns what happened; throws when the attempt failed and another one is
 * due (the job queue retries it, with a growing delay).
 */
export async function scanItem(deps: ScanDependencies, itemId: string): Promise<ScanOutcome> {
  const { db } = deps;
  const [item] = await db.select().from(moderationItem).where(eq(moderationItem.id, itemId));
  if (item?.scanStatus !== 'waiting') return 'skipped';
  // Blocked, but its stored objects weren't all deleted yet.
  if (isHashMatched(item)) {
    await finishBlock(deps, item.id);
    return 'blocked';
  }
  try {
    return await runScan(deps, item);
  } catch (error) {
    const [now] = await db.select().from(moderationItem).where(eq(moderationItem.id, item.id));
    // Blocked, then deleting its stored objects failed: retried until they are gone, never given up.
    if (now && isHashMatched(now)) throw error;
    const attempts = item.scanAttempts + 1;
    const last = attempts >= MAX_SCAN_ATTEMPTS;
    const message =
      error instanceof ScanError ? error.message : 'The check failed for an unexpected reason.';
    await db
      .update(moderationItem)
      .set({
        scanAttempts: attempts,
        // Merged, so a hash check that passed in this attempt is kept.
        scanResult: sql`coalesce(${moderationItem.scanResult}, '{}'::jsonb) || ${JSON.stringify({ error: message })}::jsonb`,
        ...(last && { scanStatus: 'failed' as const, scannedAt: new Date() }),
        updatedAt: new Date(),
      })
      .where(and(eq(moderationItem.id, item.id), eq(moderationItem.scanStatus, 'waiting')));
    if (last) return 'failed';
    throw error;
  }
}

async function runScan(deps: ScanDependencies, item: ModerationItemRow): Promise<ScanOutcome> {
  const { db, storage, scanners } = deps;
  const result: ScanResult = { ...item.scanResult };
  delete result.error;
  const context: ScanContext = { requestId: randomUUID(), subject: subjectOf(item) };
  let scores: CategoryScores | null = null;
  let provider: string | null = null;

  if (item.kind === 'image') {
    const [stored] = item.fileId
      ? await db.select().from(file).where(eq(file.id, item.fileId))
      : [];
    if (!stored) throw new ScanError('The image’s file record is missing.');
    if (scanners.csam && !result.hashCheck) {
      const match = await scanners.csam.match(await matchImageOf(storage, stored), context);
      if (match) {
        await blockKnownCsam(deps, {
          item,
          file: stored,
          source: 'matcher',
          matcher: scanners.csam.name,
          match,
          actor: { type: 'system', label: scanners.csam.name },
        });
        // The same bytes anywhere else are the same image: check those again.
        for (const other of await sameImageItems(db, item)) await recheck(deps, other);
        return 'blocked';
      }
      result.hashCheck = {
        matcher: scanners.csam.name,
        matched: false,
        at: new Date().toISOString(),
      };
      // Kept at once, so a classifier failure doesn't send the image to the matcher again.
      await db
        .update(moderationItem)
        .set({ scanResult: result })
        .where(and(eq(moderationItem.id, item.id), eq(moderationItem.scanStatus, 'waiting')));
    }
    if (item.status !== 'removed' && scanners.image) {
      scores = await scanners.image.scanImage(await scanImageOf(storage, stored), context);
      provider = scanners.image.name;
    }
  } else if (scanners.text) {
    const fields = (textFields(item) ?? []).map((field) => ({
      name: field.field,
      value: field.value,
    }));
    if (fields.length > 0) {
      scores = await scanners.text.scanText({ fields }, context);
      provider = scanners.text.name;
    }
  }
  return applyScores(deps, item, result, provider, scores);
}

/** A score as people read it: two decimals. */
function formatScores(scores: CategoryScores, categories: string[]): string {
  return categories
    .map((category) => `${category} ${(scores[category] ?? 0).toFixed(2)}`)
    .join(', ');
}

async function applyScores(
  deps: ScanDependencies,
  item: ModerationItemRow,
  result: ScanResult,
  provider: string | null,
  scores: CategoryScores | null,
): Promise<ScanOutcome> {
  const { db, config } = deps;
  const now = new Date();
  const decision =
    scores && provider ? decide(config.moderation.thresholds, scores) : { hold: [], remove: [] };
  if (scores && provider) {
    result.classifier = { provider, at: now.toISOString(), scores, ...decision };
  }
  const note =
    decision.remove.length > 0 && scores
      ? `Removed by the automatic check (${provider}): ${formatScores(scores, decision.remove)}.`
      : null;

  const outcome = await db.transaction(async (tx): Promise<ScanOutcome> => {
    const [current] = await tx
      .select()
      .from(moderationItem)
      .where(eq(moderationItem.id, item.id))
      .for('update');
    if (current?.scanStatus !== 'waiting') return 'skipped';
    const flags: ModerationFlag[] =
      decision.hold.length > 0 && scores && provider
        ? [
            {
              source: 'scan',
              at: now.toISOString(),
              provider,
              categories: Object.fromEntries(
                decision.hold.map((category) => [category, scores[category] ?? 0]),
              ),
            },
          ]
        : [];
    await tx
      .update(moderationItem)
      .set({
        scanStatus: 'done',
        scannedAt: now,
        scanResult: result,
        ...(flags.length > 0 && {
          flags: sql`${moderationItem.flags} || ${JSON.stringify(flags)}::jsonb`,
        }),
        updatedAt: now,
      })
      .where(eq(moderationItem.id, item.id));
    if (current.status !== 'pending') return 'recorded';
    if (note) {
      await decideItems(tx, [item.id], 'removed', { userId: null, note });
      await recordAudit(tx, {
        orgId: item.orgId,
        actor: SCAN_ACTOR,
        action: 'moderation.removed',
        target: { type: 'moderation_item', id: item.id },
        data: {
          kind: item.kind,
          subject: { type: item.subjectType, id: item.subjectId },
          from: 'pending',
          reason: note,
          automatic: true,
        },
      });
      return 'removed';
    }
    if (flags.length > 0) return 'held';
    // Held anyway by the review policy, the word list or a report: a person decides.
    if (current.flags.length > 0) return 'waiting';
    await decideItems(tx, [item.id], 'cleared', {
      userId: null,
      note: 'Published after the automatic check.',
    });
    return 'cleared';
  });

  if (outcome === 'removed' && note) {
    const [org] = await db
      .execute<{ name: string; subject: string | null }>(sql`
      select o.name, coalesce(a.name, i.name, o.name) as subject
      from organization o
      left join achievement a on a.id = ${item.subjectId}
      left join issuer i on i.id = ${item.subjectId}
      where o.id = ${item.orgId}
    `)
      .then((answer) => answer.rows);
    const what = describeItem(item, org?.subject ?? '');
    for (const to of await ownerEmails(db, item.orgId)) {
      await deps.outbox.send(
        contentRemovedMessage(to, org?.name ?? '', what, note, { abuseEmail: config.abuseEmail }),
      );
    }
  }
  return outcome;
}

/** Puts an item back to waiting for its check (the hash check included) and asks for it. */
export async function recheck(
  deps: Pick<ScanDependencies, 'db' | 'jobs'>,
  item: Pick<ModerationItemRow, 'id' | 'scanResult'>,
): Promise<void> {
  const { hashCheck: _hashCheck, error: _error, ...rest } = item.scanResult ?? {};
  await deps.db
    .update(moderationItem)
    .set({
      scanStatus: 'waiting',
      scanAttempts: 0,
      scanResult: Object.keys(rest).length > 0 ? rest : null,
      updatedAt: new Date(),
    })
    .where(eq(moderationItem.id, item.id));
  await deps.jobs?.scanContent(item.id);
}

/**
 * For the worker's sweep: items whose check waits longer than a minute (their job was lost, or
 * saved where no job queue was passed), oldest first.
 */
export async function scansToResume(db: Database, limit = 50): Promise<string[]> {
  const rows = await db
    .select({ id: moderationItem.id })
    .from(moderationItem)
    .where(
      and(
        eq(moderationItem.scanStatus, 'waiting'),
        lt(moderationItem.updatedAt, new Date(Date.now() - 60_000)),
      ),
    )
    .orderBy(asc(moderationItem.createdAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Once a scanner is set up, items that were already waiting for a platform admin get their check
 * too (a few at a time): the scores help whoever reviews them, and with a known-CSAM matcher no
 * one sees an image it hasn't checked. Published content isn't scanned again.
 */
export async function checkWaitingItems(
  db: Database,
  scan: Config['moderation']['scan'],
  limit = 20,
): Promise<string[]> {
  const kinds = [
    ...(scan.images ? ['image' as const] : []),
    ...(scan.text ? ['text' as const] : []),
  ];
  if (kinds.length === 0) return [];
  const rows = await db
    .select({ id: moderationItem.id })
    .from(moderationItem)
    .where(
      and(
        eq(moderationItem.status, 'pending'),
        isNull(moderationItem.scanStatus),
        or(...kinds.map((kind) => eq(moderationItem.kind, kind))),
      ),
    )
    .orderBy(asc(moderationItem.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const marked = await db
    .update(moderationItem)
    .set({ scanStatus: 'waiting', updatedAt: new Date() })
    .where(
      and(
        isNull(moderationItem.scanStatus),
        inArray(
          moderationItem.id,
          rows.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: moderationItem.id });
  return marked.map((row) => row.id);
}
