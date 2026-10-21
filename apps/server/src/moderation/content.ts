import { createHash } from 'node:crypto';
import type { AlignmentData } from '@credforge/db';

/**
 * The public text of an org, issuer or achievement, as one moderation item reviews it (design
 * plan §6.5). Each is built with a fixed key order, so the same text always has the same hash
 * and going back to text that was already reviewed finds its item again.
 */

export interface OrgText {
  name: string;
}

export interface IssuerText {
  name: string;
  description: string | null;
  website: string | null;
  email: string | null;
}

export interface AchievementText {
  name: string;
  description: string;
  criteriaNarrative: string | null;
  criteriaUrl: string | null;
  tags: string[];
  alignments: AlignmentData[];
}

export type SubjectText = OrgText | IssuerText | AchievementText;

export function orgText(row: { name: string }): OrgText {
  return { name: row.name };
}

export function issuerText(row: {
  name: string;
  description: string | null;
  url: string | null;
  email: string | null;
}): IssuerText {
  return {
    name: row.name,
    description: row.description,
    website: row.url,
    email: row.email,
  };
}

export function achievementText(row: {
  name: string;
  description: string;
  criteriaNarrative: string | null;
  criteriaUrl: string | null;
  tags: string[];
  alignments: AlignmentData[];
}): AchievementText {
  return {
    name: row.name,
    description: row.description,
    criteriaNarrative: row.criteriaNarrative,
    criteriaUrl: row.criteriaUrl,
    tags: [...row.tags],
    alignments: row.alignments.map((alignment) => ({
      targetName: alignment.targetName,
      targetUrl: alignment.targetUrl,
      ...(alignment.targetDescription && { targetDescription: alignment.targetDescription }),
      ...(alignment.targetFramework && { targetFramework: alignment.targetFramework }),
      ...(alignment.targetCode && { targetCode: alignment.targetCode }),
      ...(alignment.targetType && { targetType: alignment.targetType }),
    })),
  };
}

/** Hex SHA-256 of the text as stored in `moderation_item.content`. */
export function textHash(content: SubjectText): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** Every string in the text, for the word list. */
export function textValues(content: SubjectText): string[] {
  const values: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(content);
  return values;
}
