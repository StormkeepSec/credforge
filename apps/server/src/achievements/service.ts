import type { Achievement as AchievementResponse } from '@credforge/contracts';
import {
  type AchievementSnapshot,
  type AlignmentData,
  type achievement,
  and,
  credential,
  eq,
  inArray,
  type Queryable,
  sql,
} from '@credforge/db';
import { type AchievementInput, CREDENTIAL_CONTEXT } from '@credforge/ob3';
import { type FileRow, imageSet } from '../files/service';

export type AchievementRow = typeof achievement.$inferSelect;

/** The achievement's permanent id, embedded in every credential awarded from it (§5.1). */
export function achievementUrl(publicBaseUrl: string, achievementId: string): string {
  return `${publicBaseUrl}/achievements/${achievementId}`;
}

/** The signed fields, as an `achievement_revision` stores them. */
export function snapshotOf(row: AchievementRow): AchievementSnapshot {
  return {
    name: row.name,
    description: row.description,
    criteriaNarrative: row.criteriaNarrative,
    criteriaUrl: row.criteriaUrl,
    achievementType: row.achievementType,
    imageFileId: row.imageFileId,
    tags: row.tags,
    alignments: row.alignments,
    validForDays: row.validForDays,
  };
}

/** Field names whose values differ between two snapshots. */
export function changedFields(before: AchievementSnapshot, after: AchievementSnapshot): string[] {
  return (Object.keys(after) as (keyof AchievementSnapshot)[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

function compactAlignment(alignment: AlignmentData) {
  return {
    targetName: alignment.targetName,
    targetUrl: alignment.targetUrl,
    ...(alignment.targetDescription && { targetDescription: alignment.targetDescription }),
    ...(alignment.targetFramework && { targetFramework: alignment.targetFramework }),
    ...(alignment.targetCode && { targetCode: alignment.targetCode }),
    ...(alignment.targetType && { targetType: alignment.targetType }),
  };
}

/** The OB `Achievement` input for @credforge/ob3: what gets signed into a credential. */
export function obAchievementInput(
  publicBaseUrl: string,
  achievementId: string,
  snapshot: AchievementSnapshot,
  image: FileRow | undefined,
): AchievementInput {
  return {
    id: achievementUrl(publicBaseUrl, achievementId),
    name: snapshot.name,
    description: snapshot.description,
    criteria: {
      ...(snapshot.criteriaUrl && { id: snapshot.criteriaUrl }),
      ...(snapshot.criteriaNarrative && { narrative: snapshot.criteriaNarrative }),
    },
    achievementType: snapshot.achievementType,
    image: image ? { id: imageSet(publicBaseUrl, image).url, caption: snapshot.name } : undefined,
    tag: snapshot.tags.length > 0 ? snapshot.tags : undefined,
    alignment:
      snapshot.alignments.length > 0 ? snapshot.alignments.map(compactAlignment) : undefined,
  };
}

/**
 * The JSON served at the achievement's URL: the OB 3.0 `Achievement` (current revision), with
 * the contexts that define its terms.
 */
export function achievementDocument(
  publicBaseUrl: string,
  row: AchievementRow,
  image: FileRow | undefined,
  creator: { id: string; name: string },
): Record<string, unknown> {
  const input = obAchievementInput(publicBaseUrl, row.id, snapshotOf(row), image);
  return {
    '@context': CREDENTIAL_CONTEXT.slice(0, 2),
    id: input.id,
    type: ['Achievement'],
    achievementType: input.achievementType,
    name: input.name,
    description: input.description,
    criteria: input.criteria,
    ...(input.image && {
      image: { ...(input.image as { id: string; caption?: string }), type: 'Image' },
    }),
    creator: { id: creator.id, type: ['Profile'], name: creator.name },
    ...(input.tag && { tag: input.tag }),
    ...(input.alignment && {
      alignment: input.alignment.map((alignment) => ({ type: ['Alignment'], ...alignment })),
    }),
  };
}

export function serializeAchievement(
  publicBaseUrl: string,
  row: AchievementRow,
  files: Map<string, FileRow>,
  awardedCount: number,
): AchievementResponse {
  const image = row.imageFileId ? files.get(row.imageFileId) : undefined;
  return {
    id: row.id,
    url: achievementUrl(publicBaseUrl, row.id),
    issuerId: row.issuerId,
    name: row.name,
    description: row.description,
    criteriaNarrative: row.criteriaNarrative,
    criteriaUrl: row.criteriaUrl,
    achievementType: row.achievementType,
    tags: row.tags,
    alignments: row.alignments.map((alignment) => ({
      targetName: alignment.targetName,
      targetUrl: alignment.targetUrl,
      targetDescription: alignment.targetDescription ?? null,
      targetFramework: alignment.targetFramework ?? null,
      targetCode: alignment.targetCode ?? null,
      targetType: alignment.targetType ?? null,
    })),
    validForDays: row.validForDays,
    image: image ? imageSet(publicBaseUrl, image) : null,
    revision: row.revision,
    status: row.status,
    awardedCount,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Credentials issued per achievement. */
export async function awardedCounts(
  db: Queryable,
  orgId: string,
  achievementIds: string[],
): Promise<Map<string, number>> {
  if (achievementIds.length === 0) return new Map();
  const rows = await db
    .select({ id: credential.achievementId, count: sql<number>`count(*)::int` })
    .from(credential)
    .where(and(eq(credential.orgId, orgId), inArray(credential.achievementId, achievementIds)))
    .groupBy(credential.achievementId);
  return new Map(rows.map((row) => [row.id, row.count]));
}
