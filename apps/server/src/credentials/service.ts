import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  awardInput,
  CredentialDetails,
  CredentialState,
  CredentialSummary,
  DeliveryStatus,
  EmailDelivery,
  Revocation,
} from '@credforge/contracts';
import {
  achievement,
  and,
  apiKey,
  auditEvent,
  credential,
  type Database,
  desc,
  emailMessage,
  eq,
  gt,
  inArray,
  issuer,
  member,
  organization,
  type Queryable,
  sql,
  user,
} from '@credforge/db';
import { generateSalt, issueCredential, type SignedOpenBadgeCredential } from '@credforge/ob3';
import type { z } from 'zod';
import { obAchievementInput } from '../achievements/service';
import { ApiError, notFound } from '../api/errors';
import { recordAudit } from '../audit/audit';
import { type Config, parseMailbox } from '../config';
import type { KeyEncryption } from '../crypto/key-encryption';
import { awardMessage } from '../email/messages';
import type { EmailOutbox } from '../email/outbox';
import { type FileRow, imageSet, loadFiles, retainFiles } from '../files/service';
import {
  issuerProfileDocument,
  issuerRefInput,
  keysForIssuers,
  loadSigner,
} from '../issuers/service';
import { effectiveDailySendLimit } from '../orgs/service';
import { allocateStatusEntry } from '../status-lists/service';

export type CredentialRow = typeof credential.$inferSelect;
export type EmailMessageRow = typeof emailMessage.$inferSelect;

/** The credential's permanent id and page: `{PUBLIC_BASE_URL}/credentials/{id}`. */
export function credentialUrl(publicBaseUrl: string, credentialId: string): string {
  return `${publicBaseUrl}/credentials/${credentialId}`;
}

// ---- claim tokens (design plan §8.4) ----

export const CLAIM_TOKEN_DAYS = 90;

/** SHA-256 (hex) of a claim token: all that is stored. */
export function hashClaimToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A new 256-bit claim token, its hash, and when it stops working. */
export function newClaimToken(now = new Date()) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashClaimToken(token),
    expiresAt: new Date(now.getTime() + CLAIM_TOKEN_DAYS * 24 * 60 * 60 * 1000),
  };
}

export function claimUrl(publicBaseUrl: string, credentialId: string, token: string): string {
  return `${credentialUrl(publicBaseUrl, credentialId)}?t=${token}`;
}

/** Whether `token` is this credential's current, unexpired claim token. */
export function isValidClaimToken(
  row: Pick<CredentialRow, 'claimTokenHash' | 'claimTokenExpiresAt'>,
  token: string | undefined,
  now = new Date(),
): boolean {
  if (!token || !row.claimTokenHash || !row.claimTokenExpiresAt) return false;
  if (row.claimTokenExpiresAt <= now) return false;
  const given = Buffer.from(hashClaimToken(token), 'hex');
  const stored = Buffer.from(row.claimTokenHash, 'hex');
  return given.length === stored.length && cryptoEqual(given, stored);
}

function cryptoEqual(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ---- dates ----

const DAY = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The credential's `validFrom`: now by default. A calendar date means "earned that day" and
 * becomes midnight UTC of it (or now, for today in a time zone ahead of UTC). Can't be in the
 * future.
 */
export function resolveValidFrom(issuedOn: string | undefined, now = new Date()): Date {
  if (!issuedOn) return now;
  const date = new Date(DATE_ONLY.test(issuedOn) ? `${issuedOn}T00:00:00Z` : issuedOn);
  if (date.getTime() > now.getTime() + DAY) {
    throw validation('issuedOn', 'The award date can’t be in the future');
  }
  return date.getTime() > now.getTime() ? now : date;
}

/**
 * The credential's `validUntil`: the given date (a calendar date means the end of that day,
 * UTC), none for `null`, or else the achievement's default validity.
 */
export function resolveValidUntil(
  expiresOn: string | null | undefined,
  validFrom: Date,
  validForDays: number | null,
): Date | undefined {
  let date: Date | undefined;
  if (expiresOn === null) return undefined;
  if (expiresOn !== undefined) {
    date = new Date(DATE_ONLY.test(expiresOn) ? `${expiresOn}T23:59:59Z` : expiresOn);
  } else if (validForDays) {
    date = new Date(validFrom.getTime() + validForDays * DAY);
  }
  if (date && date.getTime() <= validFrom.getTime()) {
    throw validation('expiresOn', 'The expiry date must be after the award date');
  }
  return date;
}

function validation(field: string, message: string) {
  return new ApiError(400, 'validation_failed', 'Check the highlighted fields', undefined, {
    [field]: message,
  });
}

// ---- awarding ----

export interface AwardServices {
  db: Database;
  config: Config;
  keys: KeyEncryption;
  outbox: EmailOutbox;
}

/** Who awards: a member, or an API key (the worker awards a batch as whoever confirmed it). */
export interface AwardActor {
  type: 'user' | 'api_key';
  id: string;
  label: string;
}

/** Award input as parsed by `awardInput` from @credforge/contracts. */
export type ParsedAward = z.output<typeof awardInput>;

export type RequestInfo = { ip?: string | null; userAgent?: string | null };

export interface AwardOptions {
  /** The batch row this award is for. The database allows one credential per row. */
  batch?: { id: string; rowNumber: number };
  /** The credential this one corrects (reissue). Its achievement may since have been archived. */
  replaces?: { id: string };
  /** Extra CSV columns kept with the credential (not signed). */
  customFields?: Record<string, string>;
}

export const PENDING_ORG_RECIPIENT_RULE =
  'Until a platform admin approves your organization, you can award badges only to its members, at their confirmed email addresses.';

/** Throws unless the org may issue (suspended and declined orgs can't). */
export function assertOrgCanIssue(org: { status: string }): void {
  if (org.status === 'suspended' || org.status === 'declined') {
    throw new ApiError(
      403,
      'org_inactive',
      org.status === 'suspended' ? 'Organization suspended' : 'Organization not approved',
      'This organization can’t award badges.',
    );
  }
}

/** Members' confirmed addresses: all a pending org may award to (§6.3). */
export async function memberAddresses(db: Queryable, orgId: string): Promise<Set<string>> {
  const rows = await db
    .select({ email: user.email })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(and(eq(member.orgId, orgId), eq(user.emailVerified, true)));
  return new Set(rows.map((row) => row.email.toLowerCase()));
}

/**
 * Awards one credential (design plan §8.2). In one transaction: check the org may send, the
 * achievement is published and the recipient is allowed; allocate a random status-list index;
 * build the credential, sign it with the issuer's key and verify the result against the issuer's
 * published profile; store it with the hashed claim token; mark its images as retained; write the
 * audit event; and enqueue the email. Either all of it happens or none of it does.
 */
export async function awardCredential(
  services: AwardServices,
  target: { orgId: string },
  input: ParsedAward,
  actor: AwardActor,
  request: RequestInfo,
  options: AwardOptions = {},
): Promise<string> {
  return services.db.transaction((tx) =>
    awardInTransaction(tx, services, target, input, actor, request, options),
  );
}

/** `awardCredential` inside a transaction the caller controls (batches, reissues). */
export async function awardInTransaction(
  tx: Queryable,
  services: AwardServices,
  target: { orgId: string },
  input: ParsedAward,
  actor: AwardActor,
  request: RequestInfo,
  options: AwardOptions = {},
): Promise<string> {
  const { config, keys } = services;
  const base = config.publicBaseUrl;
  const sendEmail = input.sendEmail ?? true;
  const now = new Date();

  // Serializes awards per org: the send limit is counted, then used, under this lock.
  const [org] = await tx
    .select()
    .from(organization)
    .where(eq(organization.id, target.orgId))
    .for('update');
  if (!org) throw notFound('Organization');
  assertOrgCanIssue(org);

  const [row] = await tx
    .select()
    .from(achievement)
    .where(and(eq(achievement.orgId, org.id), eq(achievement.id, input.achievementId)));
  if (!row) throw validation('achievementId', 'Choose an achievement');
  const awardable =
    row.status === 'active' || (row.status === 'archived' && options.replaces !== undefined);
  if (!awardable) {
    throw new ApiError(
      409,
      'achievement_not_active',
      row.status === 'draft' ? 'Publish the achievement first' : 'The achievement is archived',
      row.status === 'draft'
        ? 'Drafts can’t be awarded.'
        : 'Restore it to award it again. Badges already awarded aren’t affected.',
    );
  }

  // Approval gate (§6.3): a pending org may award only to its own members' verified addresses.
  const email = input.recipient.email;
  if (org.status === 'pending') {
    const [own] = await tx
      .select({ id: member.id })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(and(eq(member.orgId, org.id), eq(user.email, email), eq(user.emailVerified, true)))
      .limit(1);
    if (!own) {
      throw new ApiError(
        403,
        'recipient_not_allowed',
        'Waiting for approval',
        PENDING_ORG_RECIPIENT_RULE,
      );
    }
  }

  if (sendEmail) await checkSendLimit(tx, org, config.defaultOrgDailySendLimit);

  // Locks the issuer: status-list allocation and the signing key are per issuer.
  const [issuerRow] = await tx
    .select()
    .from(issuer)
    .where(and(eq(issuer.orgId, org.id), eq(issuer.id, row.issuerId)))
    .for('update');
  if (!issuerRow) throw notFound('Issuer');
  const issuerKeys = await keysForIssuers(tx, org.id, [issuerRow.id]);
  const activeKey = issuerKeys.find((key) => key.status === 'active');
  if (!activeKey) {
    throw new ApiError(
      409,
      'issuer_not_ready',
      'The issuer has no active signing key',
      'Badges can’t be signed until the issuer has an active key.',
    );
  }
  const files = await loadFiles(tx, [row.imageFileId, issuerRow.imageFileId]);
  const image = row.imageFileId ? files.get(row.imageFileId) : undefined;
  const logo = issuerRow.imageFileId ? files.get(issuerRow.imageFileId) : undefined;

  const validFrom = resolveValidFrom(input.issuedOn, now);
  const validUntil = resolveValidUntil(input.expiresOn, validFrom, row.validForDays);

  const signer = await loadSigner(keys, base, activeKey);
  const issuerProfile = issuerProfileDocument(base, issuerRow, issuerKeys, logo);
  const status = await allocateStatusEntry(
    tx,
    { orgId: org.id, issuerId: issuerRow.id },
    { publicBaseUrl: base, signer, issuerProfile },
  );

  const id = randomUUID();
  const salt = generateSalt();
  const evidence = (input.evidence ?? []).map((item) => ({
    ...(item.url && { id: item.url }),
    ...(item.name && { name: item.name }),
    ...(item.narrative && { narrative: item.narrative }),
  }));
  // Builds, signs, schema-checks and verifies against the published profile (§5.2).
  const document: SignedOpenBadgeCredential = await issueCredential(
    {
      id: credentialUrl(base, id),
      issuer: issuerRefInput(base, issuerRow, logo),
      achievement: obAchievementInput(
        base,
        row.id,
        {
          name: row.name,
          description: row.description,
          criteriaNarrative: row.criteriaNarrative,
          criteriaUrl: row.criteriaUrl,
          achievementType: row.achievementType,
          imageFileId: row.imageFileId,
          tags: row.tags,
          alignments: row.alignments,
          validForDays: row.validForDays,
        },
        image,
      ),
      recipient: { email, salt, name: input.recipient.name },
      validFrom,
      validUntil,
      evidence: evidence.length > 0 ? evidence : undefined,
      credentialStatus: status.entry,
    },
    { signer, issuerProfile, created: now },
  );

  const claim = sendEmail ? newClaimToken(now) : null;
  await tx.insert(credential).values({
    id,
    orgId: org.id,
    issuerId: issuerRow.id,
    achievementId: row.id,
    achievementRevision: row.revision,
    imageFileId: row.imageFileId,
    recipientEmail: email,
    recipientName: input.recipient.name,
    emailSalt: salt,
    status: 'issued',
    validFrom: new Date(document.validFrom),
    validUntil: document.validUntil ? new Date(document.validUntil) : null,
    document: document as unknown as Record<string, unknown>,
    signingKeyId: activeKey.id,
    statusListId: status.listId,
    statusListIndex: status.index,
    evidence,
    visibility: 'public',
    claimTokenHash: claim?.hash ?? null,
    claimTokenExpiresAt: claim?.expiresAt ?? null,
    batchId: options.batch?.id ?? null,
    batchRowNumber: options.batch?.rowNumber ?? null,
    replacesId: options.replaces?.id ?? null,
    customFields: options.customFields ?? {},
    issuedByType: actor.type,
    issuedById: actor.id,
    createdAt: now,
    updatedAt: now,
  });
  // Images an issued credential refers to are never deleted (§5.4).
  await retainFiles(tx, [row.imageFileId, issuerRow.imageFileId]);
  await recordAudit(tx, {
    orgId: org.id,
    actor,
    action: 'credential.issued',
    target: { type: 'credential', id },
    data: {
      achievementId: row.id,
      achievementRevision: row.revision,
      recipientName: input.recipient.name,
      recipientEmail: email,
      emailed: sendEmail,
      ...(options.batch && { batchId: options.batch.id, batchRow: options.batch.rowNumber }),
      ...(options.replaces && { replaces: options.replaces.id }),
    },
    request,
  });

  if (claim) {
    await queueAwardEmail(tx, services, {
      orgId: org.id,
      credentialId: id,
      to: email,
      recipientName: input.recipient.name,
      issuer: issuerRow,
      achievement: row,
      image,
      token: claim.token,
      expiresAt: claim.expiresAt,
      reissue: options.replaces !== undefined,
    });
  }
  return id;
}

/**
 * The daily send cap (§6.3): award emails queued by the org in the last 24 hours, against its
 * own limit or the instance default. Call with the org row locked.
 */
export async function checkSendLimit(
  tx: Queryable,
  org: { id: string; dailySendLimit: number | null },
  defaultLimit: number,
): Promise<void> {
  const limit = effectiveDailySendLimit(org.dailySendLimit, defaultLimit);
  if (limit === null) return;
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(emailMessage)
    .where(
      and(
        eq(emailMessage.orgId, org.id),
        inArray(emailMessage.kind, ['award']),
        gt(emailMessage.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  if ((row?.count ?? 0) >= limit) {
    throw new ApiError(
      429,
      'send_limit_reached',
      'Daily email limit reached',
      `This organization can send ${limit.toLocaleString('en-US')} award emails in any 24 hours. Try again later, or ask the people who run this credforge site to raise the limit.`,
    );
  }
}

/** Records an award email as queued and enqueues it in the same transaction. */
export async function queueAwardEmail(
  tx: Queryable,
  services: Pick<AwardServices, 'config' | 'outbox'>,
  input: {
    orgId: string;
    credentialId: string;
    to: string;
    recipientName: string;
    issuer: typeof issuer.$inferSelect;
    achievement: Pick<typeof achievement.$inferSelect, 'name' | 'description'>;
    image: FileRow | undefined;
    token: string;
    expiresAt: Date;
    resend?: boolean;
    reissue?: boolean;
  },
): Promise<void> {
  const base = services.config.publicBaseUrl;
  const [message] = await tx
    .insert(emailMessage)
    .values({
      orgId: input.orgId,
      credentialId: input.credentialId,
      kind: 'award',
      toEmail: input.to,
      status: 'queued',
    })
    .returning({ id: emailMessage.id });
  if (!message) throw new Error('Insert returned no row.');
  await services.outbox.send(
    awardMessage({
      to: input.to,
      recipientName: input.recipientName,
      issuerName: input.issuer.name,
      issuerEmail: input.issuer.email,
      achievementName: input.achievement.name,
      achievementDescription: input.achievement.description,
      imageUrl: input.image ? imageSet(base, input.image).url512 : null,
      claimUrl: claimUrl(base, input.credentialId, input.token),
      claimExpiresAt: input.expiresAt,
      serviceName: serviceName(services.config),
      trackingId: message.id,
      resend: input.resend,
      reissue: input.reissue,
    }),
    { tx },
  );
}

/** EMAIL_FROM's display name ("credforge" by default). */
export function serviceName(config: Pick<Config, 'email'>): string {
  return parseMailbox(config.email.from)?.name ?? 'credforge';
}

// ---- reading ----

/** Valid, not valid yet, expired or revoked: from the status and the dates, never stored. */
export function credentialState(
  row: Pick<CredentialRow, 'status' | 'validFrom' | 'validUntil'>,
  now = new Date(),
): CredentialState {
  if (row.status === 'revoked') return 'revoked';
  if (row.validFrom > now) return 'not_yet_valid';
  if (row.validUntil && row.validUntil < now) return 'expired';
  return 'valid';
}

export function serializeRevocation(row: CredentialRow): Revocation | null {
  if (row.status !== 'revoked' || !row.revokedAt) return null;
  return {
    kind: row.revocationKind ?? 'revoked',
    at: row.revokedAt.toISOString(),
    reason: row.revocationReason,
    publicReason: row.revocationPublicReason,
  };
}

/** The latest email's status, or `not_sent`. */
export function deliveryStatus(emails: Pick<EmailMessageRow, 'status'>[]): DeliveryStatus {
  return emails[0]?.status ?? 'not_sent';
}

export function serializeEmail(row: EmailMessageRow): EmailDelivery {
  return {
    id: row.id,
    kind: row.kind,
    to: row.toEmail,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    events: row.events.map(({ event, at, reason }) => ({ event, at, ...(reason && { reason }) })),
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    bouncedAt: row.bouncedAt?.toISOString() ?? null,
  };
}

export function serializeCredentialSummary(
  publicBaseUrl: string,
  row: CredentialRow,
  achievementInfo: { name: string; image: FileRow | undefined },
  emails: EmailMessageRow[],
): CredentialSummary {
  return {
    id: row.id,
    url: credentialUrl(publicBaseUrl, row.id),
    achievement: {
      id: row.achievementId,
      name: achievementInfo.name,
      revision: row.achievementRevision,
      image128: achievementInfo.image
        ? imageSet(publicBaseUrl, achievementInfo.image).url128
        : null,
    },
    recipient: { name: row.recipientName, email: row.recipientEmail },
    status: row.status,
    state: credentialState(row),
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    visibility: row.visibility,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    delivery: deliveryStatus(emails),
    revocation: serializeRevocation(row),
    batchId: row.batchId,
    replacedById: row.replacedById,
    replacesId: row.replacesId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Emails per credential, newest first. */
export async function emailsFor(db: Queryable, orgId: string, credentialIds: string[]) {
  const map = new Map<string, EmailMessageRow[]>();
  if (credentialIds.length === 0) return map;
  const rows = await db
    .select()
    .from(emailMessage)
    .where(and(eq(emailMessage.orgId, orgId), inArray(emailMessage.credentialId, credentialIds)))
    .orderBy(sql`${emailMessage.createdAt} desc`);
  for (const row of rows) {
    if (!row.credentialId) continue;
    const list = map.get(row.credentialId) ?? [];
    list.push(row);
    map.set(row.credentialId, list);
  }
  return map;
}

export async function loadCredentialDetails(
  db: Queryable,
  publicBaseUrl: string,
  orgId: string,
  credentialId: string,
): Promise<CredentialDetails> {
  const [row] = await db
    .select({ credential, achievementName: achievement.name, imageFileId: achievement.imageFileId })
    .from(credential)
    .innerJoin(achievement, eq(credential.achievementId, achievement.id))
    .where(and(eq(credential.orgId, orgId), eq(credential.id, credentialId)));
  if (!row) throw notFound('Credential');
  const files = await loadFiles(db, [row.imageFileId]);
  const emails = (await emailsFor(db, orgId, [credentialId])).get(credentialId) ?? [];
  const issuedById = row.credential.issuedById;
  const issuedBy = !issuedById
    ? undefined
    : row.credential.issuedByType === 'api_key'
      ? (
          await db
            .select({ name: apiKey.name, prefix: apiKey.prefix })
            .from(apiKey)
            .where(eq(apiKey.id, issuedById))
        ).map((key) => ({ label: `${key.name} (${key.prefix})` }))[0]
      : (await db.select({ label: user.email }).from(user).where(eq(user.id, issuedById)))[0];
  const [revokedEvent] =
    row.credential.status === 'revoked'
      ? await db
          .select({ label: auditEvent.actorLabel })
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.orgId, orgId),
              eq(auditEvent.targetType, 'credential'),
              eq(auditEvent.targetId, credentialId),
              eq(auditEvent.action, 'credential.revoked'),
            ),
          )
          .orderBy(desc(auditEvent.id))
          .limit(1)
      : [];
  return {
    ...serializeCredentialSummary(
      publicBaseUrl,
      row.credential,
      {
        name: row.achievementName,
        image: row.imageFileId ? files.get(row.imageFileId) : undefined,
      },
      emails,
    ),
    issuedBy: {
      type: row.credential.issuedByType,
      id: row.credential.issuedById,
      label: issuedBy?.label ?? null,
    },
    claimLinkExpiresAt: row.credential.claimTokenExpiresAt?.toISOString() ?? null,
    emails: emails.map(serializeEmail),
    customFields: row.credential.customFields,
    evidence: row.credential.evidence.map((item) => ({
      url: item.id ?? null,
      name: item.name ?? null,
      narrative: item.narrative ?? null,
    })),
    revokedBy: revokedEvent ? { label: revokedEvent.label } : null,
    document: row.credential.document,
  };
}
