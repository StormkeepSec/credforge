import { achievement, and, eq, issuer, type Queryable } from '@credforge/db';
import type { FileRow } from '../files/service';
import {
  imageItems,
  loadItems,
  type ModerationItemRow,
  type ModerationPolicy,
  statusOf,
} from './service';
import { reviewAchievementText, reviewImage, reviewIssuerText } from './subjects';

/**
 * What a badge would carry, as far as review goes (design plan §6.5): its achievement's text and
 * image, and its issuer's text and logo. Held content never leaves the org: while any of it waits
 * for review, badges can be awarded only to the org's own members (and their pages stay private
 * until it is cleared); once any of it is removed, nobody can be awarded it.
 */
export const CONTENT_IN_REVIEW_RULE =
  'This badge’s text or image is waiting for review by the people who run this site. Until it is cleared you can award it only to your organization’s members, at their confirmed email addresses.';

export interface AwardContent {
  /** Items not cleared yet: the badge is held until they are. */
  held: string[];
  /** What was removed by a platform admin, if anything (nobody can be awarded it). */
  removed: ('achievement text' | 'badge image' | 'issuer profile' | 'issuer logo')[];
}

function summarize(
  parts: [AwardContent['removed'][number], ModerationItemRow | undefined][],
): AwardContent {
  const held: string[] = [];
  const removed: AwardContent['removed'] = [];
  for (const [label, item] of parts) {
    const status = statusOf(item);
    if (status === 'removed') removed.push(label);
    else if (status === 'pending' && item) held.push(item.id);
  }
  return { held, removed };
}

/**
 * The content state of an award, inside the award's transaction. Content saved without an item
 * (by a version of credforge before moderation, while it was deploying) gets one now.
 */
export async function awardContent(
  tx: Queryable,
  policy: ModerationPolicy,
  input: {
    org: { id: string; trustedAt: Date | null };
    achievement: typeof achievement.$inferSelect;
    issuer: typeof issuer.$inferSelect;
    image: FileRow | undefined;
    logo: FileRow | undefined;
  },
): Promise<AwardContent> {
  const { org } = input;
  const items = await loadItems(tx, [input.achievement.textItemId, input.issuer.textItemId]);
  const files = await imageItems(tx, [input.image?.id, input.logo?.id]);
  const text =
    (input.achievement.textItemId && items.get(input.achievement.textItemId)) ||
    (await reviewAchievementText(tx, policy, org, input.achievement, null));
  const profile =
    (input.issuer.textItemId && items.get(input.issuer.textItemId)) ||
    (await reviewIssuerText(tx, policy, org, input.issuer, null));
  const image = input.image
    ? (files.get(input.image.id) ?? (await reviewImage(tx, policy, org, input.image, null)))
    : undefined;
  const logo = input.logo
    ? (files.get(input.logo.id) ?? (await reviewImage(tx, policy, org, input.logo, null)))
    : undefined;
  return summarize([
    ['achievement text', text],
    ['badge image', image],
    ['issuer profile', profile],
    ['issuer logo', logo],
  ]);
}

/**
 * The same, read-only, for an achievement (the CSV validation report and the issuer app):
 * missing items count as held.
 */
export async function achievementContent(
  db: Queryable,
  orgId: string,
  achievementId: string,
): Promise<AwardContent> {
  const [row] = await db
    .select({ achievement, issuer })
    .from(achievement)
    .innerJoin(issuer, eq(achievement.issuerId, issuer.id))
    .where(and(eq(achievement.orgId, orgId), eq(achievement.id, achievementId)));
  if (!row) return { held: [], removed: [] };
  const items = await loadItems(db, [row.achievement.textItemId, row.issuer.textItemId]);
  const files = await imageItems(db, [row.achievement.imageFileId, row.issuer.imageFileId]);
  const content = summarize([
    ['achievement text', items.get(row.achievement.textItemId ?? '')],
    [
      'badge image',
      row.achievement.imageFileId ? files.get(row.achievement.imageFileId) : undefined,
    ],
    ['issuer profile', items.get(row.issuer.textItemId ?? '')],
    ['issuer logo', row.issuer.imageFileId ? files.get(row.issuer.imageFileId) : undefined],
  ]);
  // Missing items are held too, though they have no id to wait for yet.
  const missing =
    !row.achievement.textItemId ||
    !row.issuer.textItemId ||
    (row.achievement.imageFileId && !files.has(row.achievement.imageFileId)) ||
    (row.issuer.imageFileId && !files.has(row.issuer.imageFileId));
  return missing ? { ...content, held: [...content.held, 'missing'] } : content;
}
