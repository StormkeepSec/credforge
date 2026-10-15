import { and, type Database, desc, eq, issuer, type Queryable, statusList } from '@credforge/db';
import {
  allocateRandomIndex,
  Bitstring,
  type BitstringStatusListEntry,
  buildStatusListEntry,
  type IssuerProfileDocument,
  issueStatusListCredential,
  MIN_STATUS_LIST_LENGTH,
  type Signer,
} from '@credforge/ob3';
import type { Config } from '../config';
import type { KeyEncryption } from '../crypto/key-encryption';
import { loadFiles } from '../files/service';
import { issuerProfileDocument, issuerUrl, keysForIssuers, loadSigner } from '../issuers/service';

export type StatusListRow = typeof statusList.$inferSelect;

/** The list's permanent URL: `{PUBLIC_BASE_URL}/status/{issuerId}/{listNumber}` (design plan §9). */
export function statusListUrl(publicBaseUrl: string, issuerId: string, listNumber: number): string {
  return `${publicBaseUrl}/status/${issuerId}/${listNumber}`;
}

export interface SigningContext {
  publicBaseUrl: string;
  signer: Signer;
  /** The issuer profile as published; the self-check verifies against it. */
  issuerProfile: IssuerProfileDocument;
}

export interface AllocatedEntry {
  listId: string;
  index: number;
  entry: BitstringStatusListEntry;
}

/**
 * Hands out a random, unused index in the issuer's current revocation list (herd privacy:
 * an index says nothing about when or to whom a credential was issued), creating and signing a
 * new list when there is none or the current one is full.
 *
 * Call inside the issuing transaction, after locking the issuer row: that serializes allocation
 * per issuer, so two awards can't take the same index or create the same list.
 */
export async function allocateStatusEntry(
  tx: Queryable,
  target: { orgId: string; issuerId: string },
  signing: SigningContext,
): Promise<AllocatedEntry> {
  let [list] = await tx
    .select()
    .from(statusList)
    .where(and(eq(statusList.issuerId, target.issuerId), eq(statusList.purpose, 'revocation')))
    .orderBy(desc(statusList.listNumber))
    .limit(1)
    .for('update');

  if (!list || list.allocatedCount >= list.size) {
    list = await createStatusList(tx, target, (list?.listNumber ?? 0) + 1, signing);
  }

  const allocated = new Bitstring(list.allocated);
  const index = allocateRandomIndex(allocated);
  allocated.set(index, true);
  await tx
    .update(statusList)
    .set({
      allocated: Buffer.from(allocated.toBytes()),
      allocatedCount: list.allocatedCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(statusList.id, list.id));

  return {
    listId: list.id,
    index,
    entry: buildStatusListEntry({
      statusListCredential: statusListUrl(signing.publicBaseUrl, target.issuerId, list.listNumber),
      index,
    }),
  };
}

/** Creates an empty list and signs its first published version. */
async function createStatusList(
  tx: Queryable,
  target: { orgId: string; issuerId: string },
  listNumber: number,
  signing: SigningContext,
): Promise<StatusListRow> {
  const statuses = new Bitstring(MIN_STATUS_LIST_LENGTH);
  const document = await issueStatusListCredential(
    {
      id: statusListUrl(signing.publicBaseUrl, target.issuerId, listNumber),
      issuer: issuerUrl(signing.publicBaseUrl, target.issuerId),
      bitstring: statuses,
    },
    { signer: signing.signer, issuerProfile: signing.issuerProfile },
  );
  const [row] = await tx
    .insert(statusList)
    .values({
      orgId: target.orgId,
      issuerId: target.issuerId,
      listNumber,
      purpose: 'revocation',
      size: statuses.length,
      allocated: Buffer.from(new Bitstring(statuses.length).toBytes()),
      allocatedCount: 0,
      statuses: Buffer.from(statuses.toBytes()),
      version: 1,
      document: document as unknown as Record<string, unknown>,
      publishedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error('Insert returned no row.');
  return row;
}

/** A credential's place in a status list. */
export interface StatusEntry {
  listId: string;
  index: number;
}

/**
 * Sets the bits for revoked credentials in their lists' `statuses` and marks each list for
 * publishing. Call in the revoking transaction; the signed list is updated by the worker
 * (`publishStatusList`), a few seconds later. Returns the ids of the lists that changed.
 */
export async function setStatusBits(tx: Queryable, entries: StatusEntry[]): Promise<string[]> {
  const byList = new Map<string, number[]>();
  for (const entry of entries) {
    byList.set(entry.listId, [...(byList.get(entry.listId) ?? []), entry.index]);
  }
  const changed: string[] = [];
  // Always lock lists in the same order, so two revocations can't wait on each other.
  for (const listId of [...byList.keys()].sort()) {
    const [list] = await tx
      .select({ id: statusList.id, statuses: statusList.statuses })
      .from(statusList)
      .where(eq(statusList.id, listId))
      .for('update');
    if (!list) throw new Error(`Status list ${listId} not found.`);
    const bits = new Bitstring(list.statuses);
    let dirty = false;
    for (const index of byList.get(listId) ?? []) {
      if (!bits.get(index)) {
        bits.set(index, true);
        dirty = true;
      }
    }
    if (!dirty) continue;
    await tx
      .update(statusList)
      .set({ statuses: Buffer.from(bits.toBytes()), needsPublish: true, updatedAt: new Date() })
      .where(eq(statusList.id, listId));
    changed.push(listId);
  }
  return changed;
}

export interface PublishServices {
  db: Database;
  config: Pick<Config, 'publicBaseUrl'>;
  keys: KeyEncryption;
}

/**
 * Re-signs a list whose bits changed and publishes it as the next version (design plan §8.6).
 * Returns false when there was nothing to publish. Throws (so the job retries) when the issuer
 * has no active key to sign with.
 */
export async function publishStatusList(
  services: PublishServices,
  statusListId: string,
): Promise<boolean> {
  const base = services.config.publicBaseUrl;
  return services.db.transaction(async (tx) => {
    const [list] = await tx
      .select()
      .from(statusList)
      .where(eq(statusList.id, statusListId))
      .for('update');
    if (!list?.needsPublish) return false;
    const [issuerRow] = await tx.select().from(issuer).where(eq(issuer.id, list.issuerId));
    if (!issuerRow) throw new Error(`Issuer ${list.issuerId} not found.`);
    const issuerKeys = await keysForIssuers(tx, list.orgId, [issuerRow.id]);
    const activeKey = issuerKeys.find((key) => key.status === 'active');
    if (!activeKey) throw new Error(`Issuer ${issuerRow.id} has no active signing key.`);
    const logo = issuerRow.imageFileId
      ? (await loadFiles(tx, [issuerRow.imageFileId])).get(issuerRow.imageFileId)
      : undefined;
    const signer = await loadSigner(services.keys, base, activeKey);
    const issuerProfile = issuerProfileDocument(base, issuerRow, issuerKeys, logo);
    const document = await issueStatusListCredential(
      {
        id: statusListUrl(base, list.issuerId, list.listNumber),
        issuer: issuerUrl(base, list.issuerId),
        bitstring: new Bitstring(list.statuses),
      },
      { signer, issuerProfile },
    );
    await tx
      .update(statusList)
      .set({
        document: document as unknown as Record<string, unknown>,
        version: list.version + 1,
        publishedAt: new Date(),
        needsPublish: false,
        updatedAt: new Date(),
      })
      .where(eq(statusList.id, list.id));
    return true;
  });
}

/** Lists with changes not yet published: the sweep's safety net for a lost job. */
export async function listsWaitingToPublish(db: Queryable): Promise<string[]> {
  const rows = await db
    .select({ id: statusList.id })
    .from(statusList)
    .where(eq(statusList.needsPublish, true));
  return rows.map((row) => row.id);
}
