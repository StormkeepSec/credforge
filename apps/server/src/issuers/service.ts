import { randomUUID } from 'node:crypto';
import type { Issuer as IssuerResponse, SigningKeySummary } from '@credforge/contracts';
import { and, asc, eq, inArray, type issuer, type Queryable, signingKey } from '@credforge/db';
import {
  buildIssuerProfile,
  createEd25519Signer,
  generateEd25519KeyPair,
  type IssuerInput,
  type IssuerProfileDocument,
  type Signer,
} from '@credforge/ob3';
import { type KeyEncryption, signingKeyAad } from '../crypto/key-encryption';
import { type FileRow, imageSet } from '../files/service';
import { contentReview, type ReviewLookup } from '../moderation/service';
import { domainStatus } from './domain';

export type IssuerRow = typeof issuer.$inferSelect;
export type SigningKeyRow = typeof signingKey.$inferSelect;

/** The issuer's permanent id, embedded in every credential it signs (design plan §6.1). */
export function issuerUrl(publicBaseUrl: string, issuerId: string): string {
  return `${publicBaseUrl}/issuers/${issuerId}`;
}

/**
 * Generates an Ed25519 key pair for an issuer and stores it, the private key encrypted under the
 * master key. Returns the stored row; the plaintext secret is never returned.
 */
export async function createSigningKey(
  tx: Queryable,
  keys: KeyEncryption,
  target: { orgId: string; issuerId: string },
): Promise<SigningKeyRow> {
  const pair = await generateEd25519KeyPair();
  const id = randomUUID();
  const encryptedPrivateKey = keys.encrypt(pair.secretKeyMultibase, signingKeyAad(id));
  const [row] = await tx
    .insert(signingKey)
    .values({
      id,
      orgId: target.orgId,
      issuerId: target.issuerId,
      algorithm: 'Ed25519',
      publicKeyMultibase: pair.publicKeyMultibase,
      encryptedPrivateKey,
      kekVersion: keys.version,
      status: 'active',
    })
    .returning();
  if (!row) throw new Error('Insert returned no row.');
  return row;
}

/**
 * A signer for the issuer's active key, decrypted in memory. Used by issuing (M3); here it
 * checks right after creation that the stored key decrypts and matches its public key.
 */
export async function loadSigner(
  keys: KeyEncryption,
  publicBaseUrl: string,
  key: SigningKeyRow,
): Promise<Signer> {
  const secretKeyMultibase = keys.decrypt(
    key.encryptedPrivateKey,
    signingKeyAad(key.id),
    key.kekVersion,
  );
  return createEd25519Signer({
    controller: issuerUrl(publicBaseUrl, key.issuerId),
    publicKeyMultibase: key.publicKeyMultibase,
    secretKeyMultibase,
  });
}

export async function keysForIssuers(db: Queryable, orgId: string, issuerIds: string[]) {
  if (issuerIds.length === 0) return [];
  return db
    .select()
    .from(signingKey)
    .where(and(eq(signingKey.orgId, orgId), inArray(signingKey.issuerId, issuerIds)))
    .orderBy(asc(signingKey.createdAt));
}

function serializeKey(key: SigningKeyRow): SigningKeySummary {
  return {
    id: key.id,
    algorithm: key.algorithm,
    publicKeyMultibase: key.publicKeyMultibase,
    status: key.status,
    createdAt: key.createdAt.toISOString(),
  };
}

export function serializeIssuer(
  publicBaseUrl: string,
  row: IssuerRow,
  keys: SigningKeyRow[],
  files: Map<string, FileRow>,
  reviews: ReviewLookup,
): IssuerResponse {
  const logo = row.imageFileId ? files.get(row.imageFileId) : undefined;
  return {
    id: row.id,
    url: issuerUrl(publicBaseUrl, row.id),
    name: row.name,
    website: row.url,
    domain: domainStatus(row),
    email: row.email,
    description: row.description,
    logo: logo ? imageSet(publicBaseUrl, logo) : null,
    review: contentReview(reviews, row),
    keys: keys.filter((key) => key.issuerId === row.id).map(serializeKey),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The JSON served at the issuer's id: an OB `Profile` that is also a controller document listing
 * its keys (built by @credforge/ob3). Active and retired keys verify; revoked keys stay listed
 * with their revocation date but leave `assertionMethod`.
 */
export function issuerProfileDocument(
  publicBaseUrl: string,
  row: IssuerRow,
  keys: SigningKeyRow[],
  logo?: FileRow,
): IssuerProfileDocument {
  return buildIssuerProfile({
    id: issuerUrl(publicBaseUrl, row.id),
    name: row.name,
    url: row.url ?? undefined,
    email: row.email ?? undefined,
    description: row.description ?? undefined,
    image: logo ? imageSet(publicBaseUrl, logo).url : undefined,
    keys: keys.map((key) => ({
      publicKeyMultibase: key.publicKeyMultibase,
      revoked: key.status === 'revoked' ? (key.revokedAt ?? key.createdAt) : undefined,
    })),
  });
}

/**
 * The issuer as embedded in each credential (design plan §5.1): its id, name, website, contact
 * address and logo as they are at the moment of issue. No keys.
 */
export function issuerRefInput(publicBaseUrl: string, row: IssuerRow, logo?: FileRow): IssuerInput {
  return {
    id: issuerUrl(publicBaseUrl, row.id),
    name: row.name,
    url: row.url ?? undefined,
    email: row.email ?? undefined,
    image: logo ? imageSet(publicBaseUrl, logo).url : undefined,
  };
}
