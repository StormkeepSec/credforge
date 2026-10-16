import type { BulkRevokeResult, reissueInput } from '@credforge/contracts';
import { and, asc, credential, eq, inArray, organization, type Queryable } from '@credforge/db';
import type { z } from 'zod';
import { ApiError, notFound } from '../api/errors';
import { type AuditActor, recordAudit } from '../audit/audit';
import type { JobQueue } from '../jobs/enqueue';
import { setStatusBits } from '../status-lists/service';
import { forgetVerification } from '../verify/local';
import {
  type AwardActor,
  type AwardServices,
  assertOrgCanIssue,
  awardInTransaction,
  type CredentialRow,
  type ParsedAward,
  type RequestInfo,
} from './service';

export interface RevocationServices extends AwardServices {
  jobs?: JobQueue;
}

export interface RevokeDetails {
  /** For the org's records; never public. */
  reason: string;
  /** Shown on the public page. */
  publicReason?: string | null;
  kind?: 'revoked' | 'superseded';
  /** The corrected copy, for `superseded`. */
  replacedById?: string;
}

const SUPERSEDED_REASON = 'Replaced by a corrected copy.';

/**
 * Revokes credentials in the caller's transaction (design plan §8.6): marks them revoked, sets
 * their bits in the status lists, writes an audit event for each, and asks the worker to re-sign
 * the changed lists. Call with the rows locked and still `issued`.
 */
async function revokeRows(
  tx: Queryable,
  services: Pick<RevocationServices, 'jobs'>,
  orgId: string,
  rows: CredentialRow[],
  details: RevokeDetails,
  actor: AuditActor,
  request: RequestInfo,
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date();
  const kind = details.kind ?? 'revoked';
  await tx
    .update(credential)
    .set({
      status: 'revoked',
      revokedAt: now,
      revocationReason: details.reason,
      revocationPublicReason: details.publicReason ?? null,
      revocationKind: kind,
      ...(details.replacedById && { replacedById: details.replacedById }),
      updatedAt: now,
    })
    .where(
      and(
        eq(credential.orgId, orgId),
        inArray(
          credential.id,
          rows.map((row) => row.id),
        ),
      ),
    );
  const changedLists = await setStatusBits(
    tx,
    rows.flatMap((row) =>
      row.statusListId !== null && row.statusListIndex !== null
        ? [{ listId: row.statusListId, index: row.statusListIndex }]
        : [],
    ),
  );
  for (const row of rows) {
    await recordAudit(tx, {
      orgId,
      actor,
      action: 'credential.revoked',
      target: { type: 'credential', id: row.id },
      data: {
        kind,
        reason: details.reason,
        ...(details.publicReason && { publicReason: details.publicReason }),
        ...(details.replacedById && { replacedBy: details.replacedById }),
        recipientName: row.recipientName,
        recipientEmail: row.recipientEmail,
      },
      request,
    });
  }
  for (const listId of changedLists) await services.jobs?.publishStatusList(listId, { tx });
}

/**
 * Revokes one or many of an org's credentials. Credentials already revoked are left as they were
 * and reported, as are ids the org doesn't have.
 */
export async function revokeCredentials(
  services: RevocationServices,
  orgId: string,
  credentialIds: string[],
  details: RevokeDetails,
  actor: AuditActor,
  request: RequestInfo,
): Promise<BulkRevokeResult> {
  const result = await services.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(credential)
      .where(and(eq(credential.orgId, orgId), inArray(credential.id, credentialIds)))
      .orderBy(asc(credential.id))
      .for('update');
    const found = new Set(rows.map((row) => row.id));
    const issued = rows.filter((row) => row.status === 'issued');
    await revokeRows(tx, services, orgId, issued, details, actor, request);
    return {
      revoked: issued.map((row) => row.id),
      alreadyRevoked: rows.filter((row) => row.status === 'revoked').map((row) => row.id),
      notFound: credentialIds.filter((id) => !found.has(id)),
    };
  });
  for (const id of result.revoked) forgetVerification(id);
  return result;
}

/** Revokes one credential; 409 `already_revoked` if it was. */
export async function revokeCredential(
  services: RevocationServices,
  orgId: string,
  credentialId: string,
  details: RevokeDetails,
  actor: AwardActor,
  request: RequestInfo,
): Promise<void> {
  const result = await revokeCredentials(services, orgId, [credentialId], details, actor, request);
  if (result.notFound.length > 0) throw notFound('Credential');
  if (result.alreadyRevoked.length > 0) throw alreadyRevoked();
}

const alreadyRevoked = () =>
  new ApiError(
    409,
    'already_revoked',
    'Already revoked',
    'This badge was already revoked or replaced, so it can’t be changed.',
  );

export type ParsedReissue = z.output<typeof reissueInput>;

/**
 * Reissues a credential (design plan §8.6): signs a corrected copy (anything not given is copied
 * from the old one; the achievement is signed as it is now), revokes the old one as `superseded`,
 * links the two, and emails the recipient the new badge. One transaction, so either both change
 * or neither does. Returns the new credential's id.
 */
export async function reissueCredential(
  services: RevocationServices,
  orgId: string,
  credentialId: string,
  input: ParsedReissue,
  actor: AwardActor,
  request: RequestInfo,
): Promise<string> {
  const id = await services.db.transaction(async (tx) => {
    // The same lock order as awarding: the org, then the credential.
    const [org] = await tx
      .select({ id: organization.id, status: organization.status })
      .from(organization)
      .where(eq(organization.id, orgId))
      .for('update');
    if (!org) throw notFound('Organization');
    assertOrgCanIssue(org);
    const [old] = await tx
      .select()
      .from(credential)
      .where(and(eq(credential.orgId, orgId), eq(credential.id, credentialId)))
      .for('update');
    if (!old) throw notFound('Credential');
    if (old.status !== 'issued') throw alreadyRevoked();

    const award: ParsedAward = {
      achievementId: old.achievementId,
      recipient: {
        name: input.recipient?.name ?? old.recipientName,
        email: input.recipient?.email ?? old.recipientEmail,
      },
      issuedOn: input.issuedOn ?? old.validFrom.toISOString(),
      expiresOn:
        input.expiresOn !== undefined ? input.expiresOn : (old.validUntil?.toISOString() ?? null),
      evidence:
        input.evidence ??
        old.evidence.map((item) => ({
          url: item.id ?? null,
          name: item.name ?? null,
          narrative: item.narrative ?? null,
        })),
      sendEmail: input.sendEmail ?? true,
    };
    const newId = await awardInTransaction(tx, services, { orgId }, award, actor, request, {
      replaces: { id: old.id },
      customFields: old.customFields,
    });
    await revokeRows(
      tx,
      services,
      orgId,
      [old],
      { reason: input.reason ?? SUPERSEDED_REASON, kind: 'superseded', replacedById: newId },
      actor,
      request,
    );
    const changed = [
      award.recipient.name !== old.recipientName && 'recipientName',
      award.recipient.email !== old.recipientEmail && 'recipientEmail',
      input.issuedOn !== undefined && 'issuedOn',
      input.expiresOn !== undefined && 'expiresOn',
      input.evidence !== undefined && 'evidence',
    ].filter((field): field is string => typeof field === 'string');
    await recordAudit(tx, {
      orgId,
      actor,
      action: 'credential.reissued',
      target: { type: 'credential', id: old.id },
      data: { replacedBy: newId, changed, ...(input.reason && { reason: input.reason }) },
      request,
    });
    return newId;
  });
  forgetVerification(credentialId);
  return id;
}
