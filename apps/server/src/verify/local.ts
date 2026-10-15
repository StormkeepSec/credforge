import { and, asc, eq, issuer, type Queryable, signingKey, statusList } from '@credforge/db';
import { type CredentialVerification, verifyCredential } from '@credforge/ob3';
import { isUuid } from '../api/errors';
import { loadFiles } from '../files/service';
import { issuerProfileDocument } from '../issuers/service';

/**
 * Looks up credforge's own issuer profiles and status lists in the database, exactly as they
 * are served at their public URLs, so pages can verify this instance's credentials without HTTP.
 * Other issuers' documents need an HTTPS fetch (the /verify tool, M4).
 */
export function createLocalResolvers(db: Queryable, publicBaseUrl: string) {
  return {
    async resolveController(id: string): Promise<unknown> {
      const prefix = `${publicBaseUrl}/issuers/`;
      const issuerId = id.startsWith(prefix) ? id.slice(prefix.length) : '';
      if (!isUuid(issuerId)) return undefined;
      const [row] = await db.select().from(issuer).where(eq(issuer.id, issuerId.toLowerCase()));
      if (!row) return undefined;
      const keys = await db
        .select()
        .from(signingKey)
        .where(eq(signingKey.issuerId, row.id))
        .orderBy(asc(signingKey.createdAt));
      if (keys.length === 0) return undefined;
      const logo = row.imageFileId
        ? (await loadFiles(db, [row.imageFileId])).get(row.imageFileId)
        : undefined;
      return issuerProfileDocument(publicBaseUrl, row, keys, logo);
    },

    async loadStatusListCredential(url: string): Promise<unknown> {
      const match = new RegExp(
        `^${escapeRegExp(publicBaseUrl)}/status/([0-9a-f-]{36})/([1-9][0-9]{0,8})$`,
        'i',
      ).exec(url);
      if (!match || !isUuid(match[1] ?? '')) return undefined;
      const [row] = await db
        .select({ document: statusList.document })
        .from(statusList)
        .where(
          and(
            eq(statusList.issuerId, (match[1] as string).toLowerCase()),
            eq(statusList.listNumber, Number(match[2])),
          ),
        );
      return row?.document;
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CACHE_MS = 60_000;
const CACHE_ENTRIES = 1000;
const cache = new Map<string, { at: number; result: CredentialVerification }>();

/**
 * Verifies one of this instance's credentials (format, signature, status, validity), as the
 * credential page shows it. Results are kept for a minute: checking a signature means
 * canonicalizing the credential, which takes a few tens of milliseconds.
 */
export async function verifyLocalCredential(
  db: Queryable,
  publicBaseUrl: string,
  credentialId: string,
  document: unknown,
): Promise<CredentialVerification> {
  const hit = cache.get(credentialId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = await verifyCredential(document, createLocalResolvers(db, publicBaseUrl));
  if (cache.size >= CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(credentialId, { at: Date.now(), result });
  return result;
}

/** Drops a cached result (after a revocation or a status change). */
export function forgetVerification(credentialId: string): void {
  cache.delete(credentialId);
}
