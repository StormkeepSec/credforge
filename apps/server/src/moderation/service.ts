import {
  and,
  desc,
  eq,
  file,
  inArray,
  type ModerationFlag,
  moderationItem,
  type Queryable,
  sql,
} from '@credforge/db';
import type { Config } from '../config';
import type { FileRow } from '../files/service';
import { findBlockedTerms } from './blocklist';
import { type SubjectText, textHash, textValues } from './content';

/**
 * Holding content until it is cleared (design plan §6.5). Every version of an org's public text
 * and every uploaded image gets a `moderation_item`. Under the review policy (MODERATION_REVIEW),
 * a match in the operator's word list or a report, it is `pending`: public pages show the last
 * cleared version or a neutral placeholder, Open Graph cards and baked downloads leave it out, and
 * only the org's own members can be awarded badges carrying it. A platform admin clears or removes
 * it from the moderation queue.
 */

export type ModerationItemRow = typeof moderationItem.$inferSelect;
export type ModerationStatus = ModerationItemRow['status'];
export type SubjectType = ModerationItemRow['subjectType'];
export type ModerationPolicy = Config['moderation'];

/** Whether the org's new content waits for a platform admin under the instance's policy. */
export function reviewRequired(policy: ModerationPolicy, org: { trustedAt: Date | null }): boolean {
  return policy.review === 'all' || (policy.review === 'untrusted' && org.trustedAt === null);
}

export interface SubmitInput {
  org: { id: string; trustedAt: Date | null };
  subjectType: SubjectType;
  subjectId: string;
  submittedBy: string | null;
}

function initialState(flags: ModerationFlag[], now: Date) {
  return flags.length > 0
    ? { status: 'pending' as const, decidedAt: null, decisionNote: null }
    : { status: 'cleared' as const, decidedAt: now, decisionNote: 'Published without review.' };
}

/**
 * Records a version of a subject's public text and returns its item: the existing one when this
 * exact text was submitted before (cleared text stays cleared, removed text stays removed), else
 * a new one, held when the policy or the word list says so. Point the subject at it.
 */
export async function submitText(
  tx: Queryable,
  policy: ModerationPolicy,
  input: SubmitInput & { content: SubjectText },
): Promise<ModerationItemRow> {
  const contentHash = textHash(input.content);
  const now = new Date();
  const find = () =>
    tx
      .select()
      .from(moderationItem)
      .where(
        and(
          eq(moderationItem.kind, 'text'),
          eq(moderationItem.subjectType, input.subjectType),
          eq(moderationItem.subjectId, input.subjectId),
          eq(moderationItem.contentHash, contentHash),
        ),
      );
  const [existing] = await find();
  if (existing) return resubmitted(tx, existing, now);

  const at = now.toISOString();
  const flags: ModerationFlag[] = [];
  const terms = findBlockedTerms(policy.blocklist, textValues(input.content));
  if (terms.length > 0) flags.push({ source: 'blocklist', at, terms });
  if (reviewRequired(policy, input.org)) flags.push({ source: 'review', at });
  const [row] = await tx
    .insert(moderationItem)
    .values({
      orgId: input.org.id,
      kind: 'text',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      content: input.content as unknown as Record<string, unknown>,
      contentHash,
      flags,
      ...initialState(flags, now),
      submittedBy: input.submittedBy,
      submittedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  // Saved twice at once: the other request recorded it first.
  const [raced] = await find();
  if (!raced) throw new Error('Moderation item missing after insert conflict.');
  return raced;
}

/** Records an uploaded image (a badge image or issuer logo) and returns its item. */
export async function submitImage(
  tx: Queryable,
  policy: ModerationPolicy,
  input: SubmitInput & { file: Pick<FileRow, 'id' | 'sha256'> },
): Promise<ModerationItemRow> {
  const now = new Date();
  const find = () =>
    tx.select().from(moderationItem).where(eq(moderationItem.fileId, input.file.id));
  const [existing] = await find();
  if (existing) return resubmitted(tx, existing, now);
  const flags: ModerationFlag[] = reviewRequired(policy, input.org)
    ? [{ source: 'review', at: now.toISOString() }]
    : [];
  // An image a platform admin removed stays removed when anyone uploads the same bytes again.
  const [removedBefore] = await tx
    .select({ id: moderationItem.id })
    .from(moderationItem)
    .where(
      and(
        eq(moderationItem.kind, 'image'),
        eq(moderationItem.contentHash, input.file.sha256),
        eq(moderationItem.status, 'removed'),
      ),
    )
    .limit(1);
  const [row] = await tx
    .insert(moderationItem)
    .values({
      orgId: input.org.id,
      kind: 'image',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      fileId: input.file.id,
      contentHash: input.file.sha256,
      flags,
      ...(removedBefore
        ? {
            status: 'removed' as const,
            decidedAt: now,
            decisionNote: 'The same image was removed before.',
          }
        : initialState(flags, now)),
      submittedBy: input.submittedBy,
      submittedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [raced] = await find();
  if (!raced) throw new Error('Moderation item missing after insert conflict.');
  return raced;
}

/** The same content saved again: it becomes the version shown last (see `publicText`). */
async function resubmitted(tx: Queryable, row: ModerationItemRow, now: Date) {
  await tx.update(moderationItem).set({ submittedAt: now }).where(eq(moderationItem.id, row.id));
  return { ...row, submittedAt: now };
}

/** Items by id. */
export async function loadItems(
  db: Queryable,
  ids: (string | null | undefined)[],
): Promise<Map<string, ModerationItemRow>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select().from(moderationItem).where(inArray(moderationItem.id, wanted));
  return new Map(rows.map((row) => [row.id, row]));
}

/** Image items by file id. */
export async function imageItems(
  db: Queryable,
  fileIds: (string | null | undefined)[],
): Promise<Map<string, ModerationItemRow>> {
  const wanted = [...new Set(fileIds.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select().from(moderationItem).where(inArray(moderationItem.fileId, wanted));
  return new Map(rows.map((row) => [row.fileId as string, row]));
}

/** Review states for the issuer app: text items by id, image items by file id. */
export interface ReviewLookup {
  text: Map<string, ModerationItemRow>;
  images: Map<string, ModerationItemRow>;
}

export async function loadReviews(
  db: Queryable,
  subjects: { textItemId: string | null; imageFileId: string | null }[],
): Promise<ReviewLookup> {
  return {
    text: await loadItems(
      db,
      subjects.map((row) => row.textItemId),
    ),
    images: await imageItems(
      db,
      subjects.map((row) => row.imageFileId),
    ),
  };
}

/** How the issuer app shows a subject's review: its current text and image. */
export function contentReview(
  reviews: ReviewLookup,
  row: { textItemId: string | null; imageFileId: string | null },
) {
  return {
    text: statusOf(row.textItemId ? reviews.text.get(row.textItemId) : undefined),
    image: row.imageFileId ? statusOf(reviews.images.get(row.imageFileId)) : null,
  };
}

/**
 * Content without an item counts as held (it fails closed): everything published before
 * moderation was given a cleared item by `migrate` (decision 56).
 */
export function statusOf(item: Pick<ModerationItemRow, 'status'> | undefined): ModerationStatus {
  return item?.status ?? 'pending';
}

export interface PublicText<T> {
  /** What public pages show: the current text, the last cleared one, or null (a placeholder). */
  text: T | null;
  /** Whether `text` is the current text. */
  current: boolean;
}

/**
 * The subject's text as public pages show it: the current text once cleared; while an edit waits
 * (or after it was removed), the cleared version saved last; null when nothing was ever cleared.
 */
export async function publicText<T extends SubjectText>(
  db: Queryable,
  subject: { type: SubjectType; id: string; itemId: string | null },
  current: T,
): Promise<PublicText<T>> {
  if (subject.itemId) {
    const [item] = await db
      .select({ status: moderationItem.status })
      .from(moderationItem)
      .where(eq(moderationItem.id, subject.itemId));
    if (item?.status === 'cleared') return { text: current, current: true };
  }
  const [previous] = await db
    .select({ content: moderationItem.content })
    .from(moderationItem)
    .where(
      and(
        eq(moderationItem.kind, 'text'),
        eq(moderationItem.subjectType, subject.type),
        eq(moderationItem.subjectId, subject.id),
        eq(moderationItem.status, 'cleared'),
      ),
    )
    .orderBy(desc(moderationItem.submittedAt))
    .limit(1);
  return { text: (previous?.content as T | undefined) ?? null, current: false };
}

/**
 * The image public pages show for a subject: the current one once cleared, else the cleared image
 * of that subject saved last, else none (a placeholder).
 */
export async function publicImage(
  db: Queryable,
  subject: { type: 'achievement' | 'issuer'; id: string; fileId: string | null },
): Promise<FileRow | undefined> {
  const rows = await db
    .select({ file, status: moderationItem.status })
    .from(moderationItem)
    .innerJoin(file, eq(moderationItem.fileId, file.id))
    .where(
      and(
        eq(moderationItem.kind, 'image'),
        eq(moderationItem.subjectType, subject.type),
        eq(moderationItem.subjectId, subject.id),
        eq(moderationItem.status, 'cleared'),
      ),
    )
    .orderBy(desc(moderationItem.submittedAt))
    .limit(20);
  return rows.find((row) => row.file.id === subject.fileId)?.file ?? rows[0]?.file;
}

/**
 * Takes items off the badges awarded while they waited (`credential.held_item_ids`); a badge with
 * nothing left becomes public. Call after clearing them.
 */
export async function releaseHeldCredentials(tx: Queryable, itemIds: string[]): Promise<number> {
  if (itemIds.length === 0) return 0;
  const ids = sql`array[${sql.join(
    itemIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
  const result = await tx.execute(sql`
    update credential
    set held_item_ids = array(select x from unnest(held_item_ids) as x where x <> all(${ids})),
        updated_at = now()
    where held_item_ids && ${ids}
  `);
  return result.rowCount ?? 0;
}

export interface Decision {
  /** The platform admin deciding; null for the system. */
  userId: string | null;
  note?: string | null;
}

/** Sets items' status; returns the rows that changed. Clearing releases held badges. */
export async function decideItems(
  tx: Queryable,
  ids: string[],
  status: 'cleared' | 'removed',
  decision: Decision,
): Promise<ModerationItemRow[]> {
  if (ids.length === 0) return [];
  const now = new Date();
  const changed = await tx
    .update(moderationItem)
    .set({
      status,
      decidedAt: now,
      decidedBy: decision.userId,
      decisionNote: decision.note ?? null,
      updatedAt: now,
    })
    .where(and(inArray(moderationItem.id, ids), sql`${moderationItem.status} <> ${status}`))
    .returning();
  if (status === 'cleared') {
    await releaseHeldCredentials(
      tx,
      changed.map((row) => row.id),
    );
  }
  return changed;
}

/**
 * Holds items again (a child-safety report): they leave public pages at once, whatever was
 * decided before, until a platform admin looks. Removed items stay removed. Returns the ids held.
 */
export async function holdItems(
  tx: Queryable,
  ids: string[],
  flag: ModerationFlag,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const now = new Date();
  const changed = await tx
    .update(moderationItem)
    .set({
      status: 'pending',
      flags: sql`${moderationItem.flags} || ${JSON.stringify([flag])}::jsonb`,
      updatedAt: now,
    })
    .where(and(inArray(moderationItem.id, ids), sql`${moderationItem.status} <> 'removed'`))
    .returning({ id: moderationItem.id });
  return changed.map((row) => row.id);
}
