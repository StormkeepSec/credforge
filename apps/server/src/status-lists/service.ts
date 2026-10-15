import { and, desc, eq, type Queryable, statusList } from '@credforge/db';
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
import { issuerUrl } from '../issuers/service';

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
