import type {
  ModerationFlag as FlagView,
  ModerationItem,
  ModerationUser,
} from '@credforge/contracts';
import {
  achievement,
  and,
  asc,
  desc,
  eq,
  file,
  gt,
  inArray,
  issuer,
  lt,
  moderationItem,
  or,
  organization,
  type Queryable,
  type SQL,
  sql,
  user,
} from '@credforge/db';
import { achievementUrl } from '../achievements/service';
import { issuerUrl } from '../issuers/service';
import type { ModerationItemRow } from './service';

/** Field labels for text items, in the order the queue shows them. */
const LABELS: Record<string, Record<string, string>> = {
  organization: { name: 'Organization name' },
  issuer: { name: 'Name', description: 'Description', website: 'Website', email: 'Contact email' },
  achievement: {
    name: 'Name',
    description: 'Description',
    criteriaNarrative: 'How it is earned',
    criteriaUrl: 'Criteria page',
    tags: 'Skills',
    alignments: 'Aligned with',
  },
};

function textFields(row: ModerationItemRow): ModerationItem['text'] {
  if (row.kind !== 'text' || !row.content) return null;
  const labels = LABELS[row.subjectType] ?? {};
  const fields: NonNullable<ModerationItem['text']> = [];
  for (const [field, label] of Object.entries(labels)) {
    const value = row.content[field];
    let shown: string | null = null;
    if (typeof value === 'string') shown = value;
    else if (field === 'tags' && Array.isArray(value)) shown = value.join(', ');
    else if (field === 'alignments' && Array.isArray(value)) {
      shown = value
        .map((item) => {
          const alignment = item as Record<string, unknown>;
          return [alignment.targetName, alignment.targetUrl, alignment.targetDescription]
            .filter((part) => typeof part === 'string' && part)
            .join(' · ');
        })
        .join('\n');
    }
    if (shown) fields.push({ field, label, value: shown });
  }
  return fields;
}

function flagViews(row: ModerationItemRow): FlagView[] {
  return row.flags.map((flag) => ({
    source: flag.source,
    at: flag.at,
    terms: flag.source === 'blocklist' ? flag.terms : null,
    reportId: flag.source === 'report' ? flag.reportId : null,
    category: flag.source === 'report' ? (flag.category as FlagView['category']) : null,
  }));
}

/** Items as the moderation queue shows them, with their org, subject, uploader and image. */
export async function serializeItems(
  db: Queryable,
  publicBaseUrl: string,
  rows: ModerationItemRow[],
): Promise<ModerationItem[]> {
  if (rows.length === 0) return [];
  const ids = (pick: (row: ModerationItemRow) => string | null) => [
    ...new Set(rows.map(pick).filter((id): id is string => Boolean(id))),
  ];
  const orgIds = ids((row) => row.orgId);
  const orgs = new Map(
    (
      await db
        .select({
          id: organization.id,
          name: organization.name,
          status: organization.status,
          trustedAt: organization.trustedAt,
        })
        .from(organization)
        .where(inArray(organization.id, orgIds))
    ).map((row) => [row.id, row]),
  );
  const subjectsOf = (type: ModerationItemRow['subjectType']) =>
    ids((row) => (row.subjectType === type ? row.subjectId : null));
  const achievementIds = subjectsOf('achievement');
  const achievements = new Map(
    achievementIds.length
      ? (
          await db
            .select({
              id: achievement.id,
              name: achievement.name,
              status: achievement.status,
              removedAt: achievement.removedAt,
            })
            .from(achievement)
            .where(inArray(achievement.id, achievementIds))
        ).map((row) => [row.id, row])
      : [],
  );
  const issuerIds = subjectsOf('issuer');
  const issuers = new Map(
    issuerIds.length
      ? (
          await db
            .select({ id: issuer.id, name: issuer.name })
            .from(issuer)
            .where(inArray(issuer.id, issuerIds))
        ).map((row) => [row.id, row])
      : [],
  );
  const fileIds = ids((row) => row.fileId);
  const files = new Map(
    fileIds.length
      ? (
          await db
            .select({
              id: file.id,
              mimeType: file.mimeType,
              width: file.width,
              height: file.height,
            })
            .from(file)
            .where(inArray(file.id, fileIds))
        ).map((row) => [row.id, row])
      : [],
  );
  const userIds = ids((row) => row.submittedBy).concat(ids((row) => row.decidedBy));
  const users = new Map(
    userIds.length
      ? (
          await db
            .select({
              id: user.id,
              name: user.name,
              email: user.email,
              disabledAt: user.disabledAt,
            })
            .from(user)
            .where(inArray(user.id, userIds))
        ).map((row) => [row.id, row])
      : [],
  );
  const held = new Map(
    (
      await db.execute<{ id: string; count: number }>(sql`
        select item.id, count(c.id)::int as count
        from unnest(array[${sql.join(
          rows.map((row) => sql`${row.id}::uuid`),
          sql`, `,
        )}]) as item(id)
        join credential c on item.id = any(c.held_item_ids)
        group by item.id
      `)
    ).rows.map((row) => [row.id, row.count]),
  );
  const userOf = (id: string | null): ModerationUser | null => {
    const found = id ? users.get(id) : undefined;
    return found
      ? { id: found.id, name: found.name, email: found.email, disabled: found.disabledAt !== null }
      : null;
  };

  return rows.map((row) => {
    const org = orgs.get(row.orgId);
    const subject =
      row.subjectType === 'achievement'
        ? achievements.get(row.subjectId)
        : row.subjectType === 'issuer'
          ? issuers.get(row.subjectId)
          : org;
    const draft =
      row.subjectType === 'achievement' && achievements.get(row.subjectId)?.status === 'draft';
    const image = row.fileId ? files.get(row.fileId) : undefined;
    const decider = userOf(row.decidedBy);
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      flags: flagViews(row),
      org: {
        id: row.orgId,
        name: org?.name ?? '',
        status: org?.status ?? 'pending',
        trusted: Boolean(org?.trustedAt),
      },
      subject: {
        type: row.subjectType,
        id: row.subjectId,
        name: subject?.name ?? '',
        pageUrl:
          row.subjectType === 'achievement'
            ? draft
              ? null
              : achievementUrl(publicBaseUrl, row.subjectId)
            : row.subjectType === 'issuer'
              ? issuerUrl(publicBaseUrl, row.subjectId)
              : null,
        removed: Boolean(achievements.get(row.subjectId)?.removedAt),
      },
      text: textFields(row),
      image: image ? { mimeType: image.mimeType, width: image.width, height: image.height } : null,
      heldCredentials: held.get(row.id) ?? 0,
      submittedBy: userOf(row.submittedBy),
      submittedAt: row.submittedAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decidedBy: decider ? { name: decider.name, email: decider.email } : null,
      decisionNote: row.decisionNote,
    };
  });
}

/**
 * Pending items worth a platform admin's time: the content an org's public pages would show (the
 * current text and image of published achievements, issuers and org names), anything reported,
 * and anything a badge waits for. Drafts, unpublished achievements and versions edited away since
 * aren't public, so they stay out of the queue until they are.
 */
export const IN_QUEUE: SQL = sql`(
  (${moderationItem.kind} = 'text' and (
    exists (select 1 from ${achievement} a where a.text_item_id = ${moderationItem.id} and a.status <> 'draft' and a.removed_at is null)
    or exists (select 1 from ${issuer} i where i.text_item_id = ${moderationItem.id})
    or exists (select 1 from ${organization} o where o.name_item_id = ${moderationItem.id})
  ))
  or (${moderationItem.kind} = 'image' and (
    exists (select 1 from ${achievement} a where a.image_file_id = ${moderationItem.fileId} and a.status <> 'draft' and a.removed_at is null)
    or exists (select 1 from ${issuer} i where i.image_file_id = ${moderationItem.fileId})
  ))
  or ${moderationItem.flags} @> '[{"source": "report"}]'::jsonb
  or exists (select 1 from credential c where ${moderationItem.id} = any(c.held_item_ids))
)`;

export interface ItemListQuery {
  status: ModerationItemRow['status'];
  orgId?: string;
  before?: string;
  limit: number;
}

function parseCursor(value: string | undefined): { at: Date; id: string } | null {
  const [at, id] = (value ?? '').split('_');
  if (!at || !id) return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : { at: date, id };
}

/**
 * The queue: pending items oldest first (the longest waiting at the top), decided ones newest
 * first. `next` is the cursor for the following page.
 */
export async function listItems(
  db: Queryable,
  query: ItemListQuery,
): Promise<{ rows: ModerationItemRow[]; next: string | null }> {
  const pending = query.status === 'pending';
  const cursor = parseCursor(query.before);
  const order = pending ? moderationItem.submittedAt : moderationItem.updatedAt;
  const rows = await db
    .select()
    .from(moderationItem)
    .where(
      and(
        eq(moderationItem.status, query.status),
        query.orgId ? eq(moderationItem.orgId, query.orgId) : undefined,
        pending ? IN_QUEUE : undefined,
        cursor
          ? pending
            ? or(gt(order, cursor.at), and(eq(order, cursor.at), gt(moderationItem.id, cursor.id)))
            : or(lt(order, cursor.at), and(eq(order, cursor.at), lt(moderationItem.id, cursor.id)))
          : undefined,
      ),
    )
    .orderBy(
      ...(pending ? [asc(order), asc(moderationItem.id)] : [desc(order), desc(moderationItem.id)]),
    )
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const at = last ? (pending ? last.submittedAt : last.updatedAt) : null;
  return {
    rows: page,
    next: rows.length > query.limit && last && at ? `${at.toISOString()}_${last.id}` : null,
  };
}

/** Pending items in the queue, per org (the Platform screen's counts). */
export async function pendingCounts(
  db: Queryable,
  orgIds?: string[],
): Promise<Map<string, number>> {
  const rows = await db
    .select({ orgId: moderationItem.orgId, count: sql<number>`count(*)::int` })
    .from(moderationItem)
    .where(
      and(
        eq(moderationItem.status, 'pending'),
        IN_QUEUE,
        orgIds ? inArray(moderationItem.orgId, orgIds) : undefined,
      ),
    )
    .groupBy(moderationItem.orgId);
  return new Map(rows.map((row) => [row.orgId, row.count]));
}
