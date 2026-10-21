import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  auditEvent,
  type Database,
  eq,
  file,
  gte,
  inArray,
  isNull,
  lte,
  moderationEvidence,
  moderationItem,
  ne,
  organization,
  type Queryable,
  session,
  sql,
  user,
} from '@credforge/db';
import { type AuditActor, recordAudit } from '../audit/audit';
import type { Config } from '../config';
import {
  accountDisabledMessage,
  knownCsamBlockedMessage,
  orgSuspendedMessage,
} from '../email/messages';
import type { EmailOutbox } from '../email/outbox';
import { type FileRow, parseImageName } from '../files/service';
import type { Storage } from '../files/storage';
import { lockOrg, ownerEmails, platformAdminEmails } from '../orgs/service';
import { type EvidenceFile, envelopeSha256, keyFingerprint, sealEvidence } from './evidence';
import type { KnownCsamMatch } from './scanners';
import { isHashMatched, type ModerationItemRow } from './service';

/**
 * Blocking known child sexual abuse material (design plan §6.5, decision 61). When the configured
 * matcher (or the operator, `cli.js block-known-csam`) finds an image in a list of known CSAM:
 *
 * 1. the image, as stored, and what is known about its upload are sealed to the operator's
 *    evidence key (`evidence.ts`) and written to `moderation_evidence`, which the app's database
 *    role can append to but not read back, change or delete;
 * 2. in the same transaction the item is removed for good (its URLs answer the "Image removed"
 *    tile; nobody, platform admins included, is ever shown the image again), the org is suspended
 *    and the account that uploaded it is disabled, with neutral reasons;
 * 3. then the stored objects are deleted, so the evidence is the only copy left.
 *
 * The org's audit log and the owners' emails say only that the image was removed and the org
 * suspended for a review; the instance's log says what matched. Platform admins are emailed.
 */

export const CSAM_SUSPENSION_REASON =
  'Suspended while the people who run this site review content uploaded to it.';
export const CSAM_DISABLE_REASON =
  'Disabled while the people who run this site review content uploaded from it.';
/** The item's decision note, in the moderation queue. */
export const CSAM_DECISION_NOTE =
  'Blocked: it matches known child sexual abuse material. It is never shown, and kept only as sealed evidence.';
/** What the org's own audit log says about the image. */
const NEUTRAL_REMOVAL = 'Removed by the people who run this site.';

export interface BlockDependencies {
  db: Database;
  config: Pick<Config, 'publicBaseUrl' | 'abuseEmail' | 'moderation'>;
  storage: Storage;
  outbox: EmailOutbox;
}

export interface BlockInput {
  item: ModerationItemRow;
  file: FileRow;
  /** The configured matcher, or the operator (a match found outside credforge). */
  source: 'matcher' | 'operator';
  /** The matcher's name, or what the operator named (e.g. Cloudflare's CSAM Scanning Tool). */
  matcher: string;
  match: KnownCsamMatch;
  actor: AuditActor;
}

export interface BlockResult {
  evidenceId: string;
  /** Whether this block suspended the org (false: it already was suspended or declined). */
  suspended: boolean;
  /** The account disabled, if one was. */
  disabledEmail: string | null;
}

/** The objects that make up a stored image: the original and its derived sizes. */
function objectKeys(row: FileRow): string[] {
  return [row.key, ...Object.values(row.variants).map((variant) => variant.key)];
}

/** What the evidence keeps of the image: the original as stored, and its PNG for an SVG. */
async function evidenceFiles(storage: Storage, row: FileRow): Promise<EvidenceFile[]> {
  const files: EvidenceFile[] = [];
  const original = await storage.get(row.key);
  if (original) {
    files.push({
      name: `original.${row.mimeType === 'image/svg+xml' ? 'svg' : 'png'}`,
      mimeType: row.mimeType,
      bytes: original,
    });
  }
  const png = row.variants['512'];
  if (row.mimeType === 'image/svg+xml' && png) {
    const bytes = await storage.get(png.key);
    if (bytes) files.push({ name: '512.png', mimeType: 'image/png', bytes });
  }
  if (files.length === 0) throw new Error('The image’s stored objects are missing.');
  return files;
}

/** Everything credforge knows about the upload, for the report to the authorities. */
async function manifestFor(
  db: Queryable,
  deps: BlockDependencies,
  input: BlockInput,
  evidenceId: string,
  at: Date,
): Promise<Record<string, unknown>> {
  const { item, file: row } = input;
  const [org] = await db.select().from(organization).where(eq(organization.id, item.orgId));
  const [uploader] = item.submittedBy
    ? await db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          createdAt: user.createdAt,
        })
        .from(user)
        .where(eq(user.id, item.submittedBy))
    : [];
  // The upload's own audit events (who, when, from which address and browser).
  const uploads = await db
    .select({
      action: auditEvent.action,
      actorType: auditEvent.actorType,
      actorId: auditEvent.actorId,
      actorLabel: auditEvent.actorLabel,
      ip: auditEvent.ip,
      userAgent: auditEvent.userAgent,
      createdAt: auditEvent.createdAt,
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.targetId, item.subjectId),
        inArray(auditEvent.action, ['achievement.image_changed', 'issuer.logo_changed']),
        gte(auditEvent.createdAt, new Date(row.createdAt.getTime() - 5_000)),
        lte(auditEvent.createdAt, new Date(row.createdAt.getTime() + 10 * 60_000)),
      ),
    )
    .orderBy(asc(auditEvent.id))
    .limit(5);
  return {
    evidenceId,
    sealedAt: at.toISOString(),
    instance: deps.config.publicBaseUrl,
    detection: {
      source: input.source,
      matcher: input.matcher,
      list: input.match.list ?? null,
      reference: input.match.reference ?? null,
    },
    content: {
      itemId: item.id,
      fileId: row.id,
      kind: row.kind,
      subject: { type: item.subjectType, id: item.subjectId },
      sha256: row.sha256,
      mimeType: row.mimeType,
      width: row.width,
      height: row.height,
      size: row.size,
      storedAt: row.createdAt.toISOString(),
      storage: { driver: row.driver, bucket: row.bucket, key: row.key },
      decidedBefore: { status: item.status, decidedAt: item.decidedAt?.toISOString() ?? null },
    },
    organization: org
      ? {
          id: org.id,
          name: org.name,
          status: org.status,
          createdAt: org.createdAt.toISOString(),
          createdBy: org.createdBy,
        }
      : { id: item.orgId },
    uploader: uploader
      ? { ...uploader, createdAt: uploader.createdAt.toISOString() }
      : { note: 'Uploaded with an API key or by credforge itself: see the audit events.' },
    uploadEvents: uploads.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
  };
}

/** Seals the evidence, removes the item, suspends the org and disables the uploader. */
export async function blockKnownCsam(
  deps: BlockDependencies,
  input: BlockInput,
): Promise<BlockResult> {
  const { db, config } = deps;
  const publicKey = config.moderation.evidencePublicKey;
  if (!publicKey) {
    throw new Error('CSAM_EVIDENCE_PUBLIC_KEY isn’t set: known-CSAM evidence can’t be sealed.');
  }
  const now = new Date();
  const evidenceId = randomUUID();
  const envelope = sealEvidence(publicKey, evidenceId, {
    manifest: await manifestFor(db, deps, input, evidenceId, now),
    files: await evidenceFiles(deps.storage, input.file),
  });
  const recipients = await recipientsFor(db, input.item);

  const result = await db.transaction(async (tx): Promise<BlockResult | null> => {
    // The org first, then the item: the order approving an org takes them in.
    await lockOrg(tx, input.item.orgId);
    const [current] = await tx
      .select()
      .from(moderationItem)
      .where(eq(moderationItem.id, input.item.id))
      .for('update');
    // Blocked already (by a job that ran at the same time): its evidence is kept.
    if (!current || isHashMatched(current)) return null;
    await tx.insert(moderationEvidence).values({
      id: evidenceId,
      orgId: current.orgId,
      itemId: current.id,
      fileId: input.file.id,
      contentSha256: input.file.sha256,
      source: input.source,
      matcher: input.matcher,
      keyFingerprint: keyFingerprint(publicKey),
      envelope,
      envelopeSha256: envelopeSha256(envelope),
    });
    const flag = {
      source: 'hash_match' as const,
      at: now.toISOString(),
      matcher: input.matcher,
      evidenceId,
    };
    await tx
      .update(moderationItem)
      .set({
        status: 'removed',
        decidedAt: now,
        decidedBy: null,
        decisionNote: CSAM_DECISION_NOTE,
        flags: sql`${moderationItem.flags} || ${JSON.stringify([flag])}::jsonb`,
        // Done once the stored objects are deleted (`finishBlock`).
        scanStatus: 'waiting',
        scanResult: {
          ...current.scanResult,
          hashCheck: { matcher: input.matcher, matched: true, at: now.toISOString() },
          error: undefined,
        },
        updatedAt: now,
      })
      .where(eq(moderationItem.id, current.id));
    // The instance's log says what matched; the org's says only what was done.
    await recordAudit(tx, {
      orgId: null,
      actor: input.actor,
      action: 'moderation.known_csam_blocked',
      target: { type: 'moderation_item', id: current.id },
      data: {
        orgId: current.orgId,
        source: input.source,
        matcher: input.matcher,
        list: input.match.list ?? null,
        reference: input.match.reference ?? null,
        evidenceId,
        sha256: input.file.sha256,
        subject: { type: current.subjectType, id: current.subjectId },
      },
    });
    if (current.status !== 'removed') {
      await recordAudit(tx, {
        orgId: current.orgId,
        actor: { type: 'system', label: 'credforge' },
        action: 'moderation.removed',
        target: { type: 'moderation_item', id: current.id },
        data: {
          kind: current.kind,
          subject: { type: current.subjectType, id: current.subjectId },
          from: current.status,
          reason: NEUTRAL_REMOVAL,
        },
      });
    }

    const [suspended] = await tx
      .update(organization)
      .set({
        status: 'suspended',
        statusReason: CSAM_SUSPENSION_REASON,
        statusChangedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(organization.id, current.orgId),
          inArray(organization.status, ['pending', 'active']),
        ),
      )
      .returning({ id: organization.id });
    if (suspended) {
      await recordAudit(tx, {
        orgId: current.orgId,
        actor: { type: 'system', label: 'credforge' },
        action: 'org.suspended',
        target: { type: 'organization', id: current.orgId },
        data: { to: 'suspended', reason: CSAM_SUSPENSION_REASON },
      });
    }

    let disabledEmail: string | null = null;
    if (current.submittedBy) {
      const [disabled] = await tx
        .update(user)
        .set({ disabledAt: now, disabledReason: CSAM_DISABLE_REASON, updatedAt: now })
        .where(
          and(
            eq(user.id, current.submittedBy),
            isNull(user.disabledAt),
            // A platform admin keeps their account: take their rights away first, by hand.
            eq(user.isPlatformAdmin, false),
          ),
        )
        .returning({ id: user.id, email: user.email });
      if (disabled) {
        const ended = await tx
          .delete(session)
          .where(eq(session.userId, disabled.id))
          .returning({ id: session.id });
        await recordAudit(tx, {
          orgId: current.orgId,
          actor: { type: 'system', label: 'credforge' },
          action: 'user.disabled',
          target: { type: 'user', id: disabled.id },
          data: {
            email: disabled.email,
            reason: CSAM_DISABLE_REASON,
            sessionsEnded: ended.length,
          },
        });
        disabledEmail = disabled.email;
      }
    }
    const done = { evidenceId, suspended: Boolean(suspended), disabledEmail };
    // In the same transaction: the notices go out if and only if the block happened.
    await notify(tx, deps, input, done, recipients);
    return done;
  });
  if (!result) {
    const [existing] = await db
      .select({ id: moderationEvidence.id })
      .from(moderationEvidence)
      .where(eq(moderationEvidence.itemId, input.item.id))
      .limit(1);
    return { evidenceId: existing?.id ?? '', suspended: false, disabledEmail: null };
  }

  await finishBlock(deps, input.item.id);
  return result;
}

/**
 * Deletes a blocked image's stored objects, then marks its check done. Run again (by the worker's
 * sweep) until it succeeds: the evidence was committed before anything is deleted.
 */
export async function finishBlock(
  deps: Pick<BlockDependencies, 'db' | 'storage'>,
  itemId: string,
): Promise<void> {
  const { db, storage } = deps;
  const [row] = await db
    .select({ item: moderationItem, file })
    .from(moderationItem)
    .leftJoin(file, eq(moderationItem.fileId, file.id))
    .where(eq(moderationItem.id, itemId));
  if (!row || !isHashMatched(row.item)) return;
  if (row.file) {
    for (const key of objectKeys(row.file)) await storage.delete(key);
  }
  await db
    .update(moderationItem)
    .set({ scanStatus: 'done', scannedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(moderationItem.id, itemId), eq(moderationItem.scanStatus, 'waiting')));
}

interface Recipients {
  orgName: string;
  admins: string[];
  owners: string[];
  uploaderName: string;
}

/** Who the notices go to, looked up before the block's transaction. */
async function recipientsFor(
  db: Database,
  item: Pick<ModerationItemRow, 'orgId' | 'submittedBy'>,
): Promise<Recipients> {
  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, item.orgId));
  const [uploader] = item.submittedBy
    ? await db.select({ name: user.name }).from(user).where(eq(user.id, item.submittedBy))
    : [];
  return {
    orgName: org?.name ?? 'an organization',
    admins: await platformAdminEmails(db),
    owners: await ownerEmails(db, item.orgId),
    uploaderName: uploader?.name ?? '',
  };
}

async function notify(
  tx: Queryable,
  deps: BlockDependencies,
  input: BlockInput,
  result: BlockResult,
  recipients: Recipients,
) {
  const { config, outbox } = deps;
  const { orgName } = recipients;
  for (const to of recipients.admins) {
    await outbox.send(
      knownCsamBlockedMessage({
        to,
        orgName,
        matcher: input.matcher,
        evidenceId: result.evidenceId,
        suspended: result.suspended,
        disabledEmail: result.disabledEmail,
        queueUrl: `${config.publicBaseUrl}/app/platform/moderation`,
      }),
      { tx },
    );
  }
  const appeal = { abuseEmail: config.abuseEmail };
  if (result.suspended) {
    for (const to of recipients.owners) {
      await outbox.send(orgSuspendedMessage(to, orgName, CSAM_SUSPENSION_REASON, appeal), { tx });
    }
  }
  if (result.disabledEmail) {
    await outbox.send(
      accountDisabledMessage(
        result.disabledEmail,
        recipients.uploaderName,
        CSAM_DISABLE_REASON,
        appeal,
      ),
      { tx },
    );
  }
}

/**
 * The badge image or issuer logo at one of its public URLs (any size, `…/{sha256}-512.png` and
 * the like), with its moderation item: what a match found outside credforge points at.
 */
export async function findImageByUrl(
  db: Queryable,
  publicBaseUrl: string,
  url: string,
): Promise<{ item: ModerationItemRow; file: FileRow } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== publicBaseUrl) return null;
  const match = /^\/(achievements|issuers)\/([0-9a-f-]{36})\/images\/([^/]+)$/i.exec(
    parsed.pathname,
  );
  const name = match?.[3] ? parseImageName(match[3]) : null;
  if (!match || !name) return null;
  const [row] = await db
    .select({ item: moderationItem, file })
    .from(file)
    .innerJoin(moderationItem, eq(moderationItem.fileId, file.id))
    .where(
      and(
        eq(file.kind, match[1]?.toLowerCase() === 'achievements' ? 'badge_image' : 'issuer_logo'),
        eq(file.subjectId, (match[2] ?? '').toLowerCase()),
        eq(file.sha256, name.sha256),
      ),
    );
  return row ?? null;
}

/**
 * Other image items with the same bytes that haven't been blocked yet: the same image uploaded
 * elsewhere (perhaps before matching was set up) is the same known CSAM.
 */
export async function sameImageItems(
  db: Queryable,
  item: Pick<ModerationItemRow, 'id' | 'contentHash'>,
): Promise<ModerationItemRow[]> {
  const rows = await db
    .select()
    .from(moderationItem)
    .where(
      and(
        eq(moderationItem.kind, 'image'),
        eq(moderationItem.contentHash, item.contentHash),
        ne(moderationItem.id, item.id),
      ),
    );
  return rows.filter((row) => !isHashMatched(row));
}
