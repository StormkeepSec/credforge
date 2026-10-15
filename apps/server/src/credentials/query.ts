import type { credentialFilters } from '@credforge/contracts';
import {
  and,
  credential,
  eq,
  gt,
  gte,
  ilike,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from '@credforge/db';
import type { z } from 'zod';

export type ParsedCredentialFilters = z.output<typeof credentialFilters>;

const DAY = 24 * 60 * 60 * 1000;

/** `%` and `_` in a search term match themselves, not "anything". */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The WHERE clause for an org's credentials matching the search and filters (design plan §11.1):
 * part of the recipient's name or email, the achievement, the state (computed from the status
 * and dates, as on the public page), the batch, and the day it was awarded (UTC).
 */
export function credentialConditions(
  orgId: string,
  filters: ParsedCredentialFilters,
  now = new Date(),
): SQL | undefined {
  const q = filters.q?.trim();
  return and(
    eq(credential.orgId, orgId),
    q
      ? or(
          ilike(credential.recipientName, likePattern(q)),
          ilike(credential.recipientEmail, likePattern(q)),
        )
      : undefined,
    filters.achievementId ? eq(credential.achievementId, filters.achievementId) : undefined,
    filters.batchId ? eq(credential.batchId, filters.batchId) : undefined,
    filters.from ? gte(credential.createdAt, new Date(`${filters.from}T00:00:00Z`)) : undefined,
    filters.to
      ? lt(credential.createdAt, new Date(new Date(`${filters.to}T00:00:00Z`).getTime() + DAY))
      : undefined,
    stateCondition(filters.status, now),
  );
}

function stateCondition(state: ParsedCredentialFilters['status'], now: Date): SQL | undefined {
  switch (state) {
    case undefined:
      return undefined;
    case 'revoked':
      return eq(credential.status, 'revoked');
    case 'not_yet_valid':
      return and(eq(credential.status, 'issued'), gt(credential.validFrom, now));
    case 'expired':
      return and(eq(credential.status, 'issued'), lt(credential.validUntil, now));
    case 'valid':
      return and(
        eq(credential.status, 'issued'),
        lte(credential.validFrom, now),
        or(isNull(credential.validUntil), gte(credential.validUntil, now)),
      );
  }
}

/** Newest first; `before` cursors are `{createdAt ISO}_{id}`. */
export function beforeCursor(cursor: { at: Date; id: string } | undefined): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(credential.createdAt, cursor.at),
    and(eq(credential.createdAt, cursor.at), lt(credential.id, cursor.id)),
  );
}

export const newestFirst = [sql`${credential.createdAt} desc`, sql`${credential.id} desc`];
