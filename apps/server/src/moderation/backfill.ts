import {
  achievement,
  and,
  type Database,
  eq,
  file,
  inArray,
  instanceSettings,
  isNull,
  issuer,
  moderationItem,
  organization,
  sql,
} from '@credforge/db';
import { achievementText, issuerText, orgText, type SubjectText, textHash } from './content';
import { type ModerationPolicy, submitImage, submitText } from './service';

/** Recorded in `instance_settings` once existing content has its moderation items. */
export const MODERATION_BACKFILLED = 'moderation_backfilled_at';

const NOTE = 'Published before moderation (migration 0008).';

/**
 * A one-time step after migration 0008 (decision 56), run by `migrate` as the database owner.
 * Public pages show only cleared content, and content without an item counts as held, so
 * everything that was already public gets a cleared item, hashed exactly as the app hashes it:
 * org names, issuer profiles and logos, and the text and images of published achievements.
 * Drafts were never public: they go through the instance's review policy like new content. One
 * transaction; returns how many items it wrote, or null when it had run before.
 */
export async function backfillModerationItems(
  db: Database,
  policy: ModerationPolicy,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(instanceSettings)
      .values({ key: MODERATION_BACKFILLED, value: new Date().toISOString() })
      .onConflictDoNothing()
      .returning({ key: instanceSettings.key });
    if (inserted.length === 0) return null;
    const now = new Date();
    let written = 0;

    const cleared = async (
      org: { id: string },
      subjectType: 'organization' | 'issuer' | 'achievement',
      subjectId: string,
      content: SubjectText,
      submittedBy: string | null,
    ) => {
      const contentHash = textHash(content);
      const [row] = await tx
        .insert(moderationItem)
        .values({
          orgId: org.id,
          kind: 'text',
          subjectType,
          subjectId,
          content: content as unknown as Record<string, unknown>,
          contentHash,
          status: 'cleared',
          decidedAt: now,
          decisionNote: NOTE,
          submittedBy,
          submittedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: moderationItem.id });
      written += row ? 1 : 0;
      const [item] = row
        ? [row]
        : await tx
            .select({ id: moderationItem.id })
            .from(moderationItem)
            .where(
              and(
                eq(moderationItem.subjectType, subjectType),
                eq(moderationItem.subjectId, subjectId),
                eq(moderationItem.contentHash, contentHash),
              ),
            );
      return item?.id ?? null;
    };

    const orgs = await tx.select().from(organization).where(isNull(organization.nameItemId));
    for (const org of orgs) {
      const id = await cleared(org, 'organization', org.id, orgText(org), org.createdBy);
      await tx.update(organization).set({ nameItemId: id }).where(eq(organization.id, org.id));
    }

    const issuers = await tx.select().from(issuer).where(isNull(issuer.textItemId));
    for (const row of issuers) {
      const id = await cleared({ id: row.orgId }, 'issuer', row.id, issuerText(row), null);
      await tx.update(issuer).set({ textItemId: id }).where(eq(issuer.id, row.id));
    }

    const achievements = await tx.select().from(achievement).where(isNull(achievement.textItemId));
    const drafts = new Set<string>();
    for (const row of achievements) {
      if (row.status === 'draft') {
        drafts.add(row.id);
        const [org] = await tx.select().from(organization).where(eq(organization.id, row.orgId));
        if (!org) continue;
        const item = await submitText(tx, policy, {
          org,
          subjectType: 'achievement',
          subjectId: row.id,
          content: achievementText(row),
          submittedBy: row.createdBy,
        });
        written++;
        await tx.update(achievement).set({ textItemId: item.id }).where(eq(achievement.id, row.id));
        continue;
      }
      const id = await cleared(
        { id: row.orgId },
        'achievement',
        row.id,
        achievementText(row),
        row.createdBy,
      );
      await tx.update(achievement).set({ textItemId: id }).where(eq(achievement.id, row.id));
    }

    // Images: every badge image and logo without an item (old ones too: badges may show them).
    const images = await tx
      .select()
      .from(file)
      .where(
        and(
          inArray(file.kind, ['badge_image', 'issuer_logo']),
          sql`${file.subjectId} is not null`,
          sql`not exists (select 1 from ${moderationItem} where ${moderationItem.fileId} = ${file.id})`,
        ),
      );
    const draftOwners = images.filter(
      (image) => image.kind === 'badge_image' && drafts.has(image.subjectId ?? ''),
    );
    for (const image of images) {
      const subjectType = image.kind === 'badge_image' ? 'achievement' : 'issuer';
      if (draftOwners.includes(image)) {
        const [org] = await tx.select().from(organization).where(eq(organization.id, image.orgId));
        if (!org) continue;
        await submitImage(tx, policy, {
          org,
          subjectType,
          subjectId: image.subjectId as string,
          file: image,
          submittedBy: image.createdBy,
        });
      } else {
        await tx.insert(moderationItem).values({
          orgId: image.orgId,
          kind: 'image',
          subjectType,
          subjectId: image.subjectId as string,
          fileId: image.id,
          contentHash: image.sha256,
          status: 'cleared',
          decidedAt: now,
          decisionNote: NOTE,
          submittedBy: image.createdBy,
          submittedAt: image.createdAt,
        });
      }
      written++;
    }
    return written;
  });
}
