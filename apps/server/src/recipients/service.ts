import type { RecipientCredential, RecipientCredentialPage } from '@credforge/contracts';
import { and, credential, type Database, eq, type Queryable } from '@credforge/db';
import type { FastifyRequest } from 'fastify';
import { recordAudit } from '../audit/audit';
import { beforeCursor, newestFirst } from '../credentials/query';
import { type CredentialRow, credentialState, credentialUrl } from '../credentials/service';
import { type FileRow, loadFiles } from '../files/service';
import { issuerUrl } from '../issuers/service';
import { credentialView, type LiveCredentialRow, linkedInUrl } from '../public/credential-view';
import { recipientCredentialConditions } from './addresses';

/**
 * A badge as its recipient sees it in My badges (design plan §8.8): what the signed credential
 * says, as on its public page, plus its state, visibility and what the recipient can do with it.
 * A revocation shows only the issuer's public reason, never its internal one.
 */
export function serializeRecipientCredential(
  publicBaseUrl: string,
  row: LiveCredentialRow,
  image: FileRow | undefined,
): RecipientCredential {
  const view = credentialView(publicBaseUrl, row, image);
  const url = credentialUrl(publicBaseUrl, row.id);
  return {
    id: row.id,
    url,
    achievement: {
      id: row.achievementId,
      url: view.achievement.url,
      name: view.achievement.name,
      description: view.achievement.description,
      image: view.image?.url ?? null,
    },
    issuer: {
      id: row.issuerId,
      url: issuerUrl(publicBaseUrl, row.issuerId),
      name: view.issuer.name,
      logo: view.issuer.logoUrl,
    },
    recipient: { name: row.recipientName ?? '', email: row.recipientEmail ?? '' },
    state: credentialState(row),
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    revocation:
      row.status === 'revoked' && row.revokedAt
        ? {
            kind: row.revocationKind ?? 'revoked',
            at: row.revokedAt.toISOString(),
            publicReason: row.revocationPublicReason,
          }
        : null,
    visibility: row.visibility,
    // A held badge image answers the download with a note to wait (design plan §6.5).
    downloads: { ...view.downloads, png: view.downloads.png ?? `${url}/badge.png` },
    linkedInUrl: linkedInUrl(view, url, row.id),
    createdAt: row.createdAt.toISOString(),
  };
}

async function serializeAll(
  db: Queryable,
  publicBaseUrl: string,
  rows: LiveCredentialRow[],
): Promise<RecipientCredential[]> {
  const files = await loadFiles(
    db,
    rows.map((row) => row.imageFileId),
  );
  return rows.map((row) =>
    serializeRecipientCredential(
      publicBaseUrl,
      row,
      row.imageFileId ? files.get(row.imageFileId) : undefined,
    ),
  );
}

const live = (row: CredentialRow): row is LiveCredentialRow => row.document !== null;

/** The badges awarded to these confirmed addresses, by any organization, newest first. */
export async function listRecipientCredentials(
  db: Queryable,
  publicBaseUrl: string,
  addresses: string[],
  page: { before?: { at: Date; id: string }; limit: number },
): Promise<RecipientCredentialPage> {
  if (addresses.length === 0) return { credentials: [], next: null, addresses };
  const rows = await db
    .select()
    .from(credential)
    .where(and(recipientCredentialConditions(addresses), beforeCursor(page.before)))
    .orderBy(...newestFirst)
    .limit(page.limit + 1);
  const shown = rows.slice(0, page.limit).filter(live);
  const last = shown.at(-1);
  return {
    credentials: await serializeAll(db, publicBaseUrl, shown),
    next: rows.length > page.limit && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
    addresses,
  };
}

/** One of the recipient's badges, or undefined when it isn't theirs (or doesn't exist). */
export async function findRecipientCredential(
  db: Queryable,
  addresses: string[],
  id: string,
): Promise<LiveCredentialRow | undefined> {
  if (addresses.length === 0) return undefined;
  const [row] = await db
    .select()
    .from(credential)
    .where(and(eq(credential.id, id), recipientCredentialConditions(addresses)));
  return row && live(row) ? row : undefined;
}

export async function loadRecipientCredential(
  db: Queryable,
  publicBaseUrl: string,
  row: LiveCredentialRow,
): Promise<RecipientCredential> {
  const [serialized] = await serializeAll(db, publicBaseUrl, [row]);
  if (!serialized) throw new Error('Serializing returned nothing.');
  return serialized;
}

/**
 * The recipient acting on their badge, through their claim link or signed in with its address:
 * their name, IP address and browser go into the event's sealed recipient details (design plan
 * §12.1), not its plain columns. The org's log reads the same either way.
 */
export function recipientActing(row: CredentialRow, request: FastifyRequest) {
  return row.auditKey
    ? {
        recipient: {
          key: row.auditKey,
          actorLabel: row.recipientName,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        },
      }
    : {};
}

/**
 * The recipient hides their badge's page or makes it public again; recorded in the awarding
 * org's audit log (`credential.hidden` / `credential.shown`, actor `recipient`). Returns whether
 * anything changed.
 */
export async function changeVisibility(
  db: Database,
  row: CredentialRow,
  wanted: 'public' | 'hidden',
  request: FastifyRequest,
): Promise<boolean> {
  if (wanted === row.visibility) return false;
  await db.transaction(async (tx) => {
    await tx
      .update(credential)
      .set({ visibility: wanted, updatedAt: new Date() })
      .where(eq(credential.id, row.id));
    await recordAudit(tx, {
      orgId: row.orgId,
      actor: { type: 'recipient' },
      action: wanted === 'hidden' ? 'credential.hidden' : 'credential.shown',
      target: { type: 'credential', id: row.id },
      ...recipientActing(row, request),
    });
  });
  return true;
}
