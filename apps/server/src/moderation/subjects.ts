import { achievement, eq, issuer, organization, type Queryable } from '@credforge/db';
import type { FileRow } from '../files/service';
import { achievementText, issuerText, orgText } from './content';
import { type ModerationItemRow, type ModerationPolicy, submitImage, submitText } from './service';

/**
 * Called wherever public text or an image is saved (design plan §6.5): records the version for
 * review and points the subject at it, in the caller's transaction.
 */

type OrgRef = { id: string; trustedAt: Date | null };

export async function reviewOrgName(
  tx: Queryable,
  policy: ModerationPolicy,
  org: OrgRef & { name: string },
  submittedBy: string | null,
): Promise<ModerationItemRow> {
  const item = await submitText(tx, policy, {
    org,
    subjectType: 'organization',
    subjectId: org.id,
    content: orgText(org),
    submittedBy,
  });
  await tx.update(organization).set({ nameItemId: item.id }).where(eq(organization.id, org.id));
  return item;
}

export async function reviewIssuerText(
  tx: Queryable,
  policy: ModerationPolicy,
  org: OrgRef,
  row: typeof issuer.$inferSelect,
  submittedBy: string | null,
): Promise<ModerationItemRow> {
  const item = await submitText(tx, policy, {
    org,
    subjectType: 'issuer',
    subjectId: row.id,
    content: issuerText(row),
    submittedBy,
  });
  if (row.textItemId !== item.id) {
    await tx.update(issuer).set({ textItemId: item.id }).where(eq(issuer.id, row.id));
  }
  return item;
}

export async function reviewAchievementText(
  tx: Queryable,
  policy: ModerationPolicy,
  org: OrgRef,
  row: typeof achievement.$inferSelect,
  submittedBy: string | null,
): Promise<ModerationItemRow> {
  const item = await submitText(tx, policy, {
    org,
    subjectType: 'achievement',
    subjectId: row.id,
    content: achievementText(row),
    submittedBy,
  });
  if (row.textItemId !== item.id) {
    await tx.update(achievement).set({ textItemId: item.id }).where(eq(achievement.id, row.id));
  }
  return item;
}

/** A badge image (its achievement) or issuer logo (its issuer). */
export function reviewImage(
  tx: Queryable,
  policy: ModerationPolicy,
  org: OrgRef,
  image: FileRow,
  submittedBy: string | null,
): Promise<ModerationItemRow> {
  return submitImage(tx, policy, {
    org,
    subjectType: image.kind === 'badge_image' ? 'achievement' : 'issuer',
    subjectId: image.subjectId ?? '',
    file: image,
    submittedBy,
  });
}
