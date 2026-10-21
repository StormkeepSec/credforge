import { eq, file, type Queryable, sql } from '@credforge/db';
import type { FastifyReply } from 'fastify';
import { ApiError } from '../api/errors';
import type { RateLimiter } from '../api/rate-limit';
import type { Config } from '../config';

/**
 * Upload limits per org (design plan §6.5): image and CSV uploads per hour, and the space its
 * stored files take. Each org may have its own (set by a platform admin); otherwise the instance
 * defaults apply. 0 means no limit.
 */

export type OrgUploadLimits = {
  id: string;
  uploadRateLimit: number | null;
  storageQuotaMb: number | null;
};

const MB = 1024 * 1024;

export function effectiveLimit(own: number | null, instance: number): number | null {
  const limit = own ?? instance;
  return limit === 0 ? null : limit;
}

/** Bytes the org's files take in storage: originals and every derived size. */
export async function storageUsed(db: Queryable, orgId: string): Promise<number> {
  const [row] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${file.size} + coalesce((select sum((v.value->>'size')::bigint) from jsonb_each(${file.variants}) as v), 0)), 0)`,
    })
    .from(file)
    .where(eq(file.orgId, orgId));
  return Number(row?.bytes ?? 0);
}

/** One hour, for the upload limiter. */
export const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

/**
 * Counts an upload against the org's hourly limit and checks it fits its storage quota (`bytes`:
 * at least what the upload will store). Throws 429 (with Retry-After on the reply) or 403 when it
 * doesn't.
 */
export async function checkUpload(
  db: Queryable,
  config: Pick<Config, 'orgUploadRateLimit' | 'orgStorageQuotaMb'>,
  limiter: RateLimiter,
  org: OrgUploadLimits,
  bytes: number,
  reply: Pick<FastifyReply, 'header'>,
): Promise<void> {
  const rate = effectiveLimit(org.uploadRateLimit, config.orgUploadRateLimit);
  if (rate !== null) {
    const limit = limiter.take(`upload:${org.id}`, Date.now(), rate);
    if (!limit.allowed) {
      reply.header('retry-after', String(limit.retryAfter));
      throw new ApiError(
        429,
        'rate_limited',
        'Too many uploads',
        `This organization can upload ${rate} files an hour. Try again in ${Math.ceil(limit.retryAfter / 60)} minutes.`,
      );
    }
  }
  const quota = effectiveLimit(org.storageQuotaMb, config.orgStorageQuotaMb);
  if (quota !== null && (await storageUsed(db, org.id)) + bytes > quota * MB) {
    throw new ApiError(
      403,
      'storage_quota_exceeded',
      'Storage full',
      `This organization’s files would take more than ${quota} MB. Delete drafts you don’t need, or ask the people who run this site for more space.`,
    );
  }
}
