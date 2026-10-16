import { randomBytes } from 'node:crypto';
import { and, auditEvent, credential, eq, inArray, type Queryable } from '@credforge/db';
import { isUuid } from '../api/errors';
import { createKeyEncryption } from '../crypto/key-encryption';

export type AuditActor =
  | { type: 'user'; id: string; label: string | null }
  /** An org's API key; the label is its name and prefix. */
  | { type: 'api_key'; id: string; label: string | null }
  | { type: 'system'; id?: null; label?: string | null }
  /**
   * The recipient of a credential, acting through their claim link (no account). Their name goes
   * in the event's sealed recipient details, never in the label.
   */
  | { type: 'recipient'; id?: null; label?: null };

export interface AuditRequestInfo {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * What an event says about a credential's recipient (design plan §12.1): their name, address,
 * free text that may name them, or (when they act themselves) their name, IP address and browser.
 * It is sealed with the credential's audit key, which erasing the recipient deletes.
 */
export interface RecipientDetails {
  /** The credential's `audit_key`. */
  key: Buffer;
  /** Merged into the event's `data` when read. */
  data?: Record<string, unknown>;
  /** The recipient acting: shown as the actor's label, IP address and browser when read. */
  actorLabel?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  orgId?: string | null;
  actor: AuditActor;
  /** Dotted, past tense: `org.created`, `member.role_changed`. */
  action: string;
  target?: { type: string; id: string };
  data?: Record<string, unknown>;
  request?: AuditRequestInfo;
  /** Sealed with the target credential's audit key; needs a `credential` target. */
  recipient?: RecipientDetails;
}

// ---- sealing recipient details (design plan §12.1) ----

/** A new credential's audit key: 256 random bits. */
export function newAuditKey(): Buffer {
  return randomBytes(32);
}

/** Bound to the credential, so sealed details copied into another credential's event don't open. */
const sealAad = (credentialId: string) => `credforge:audit-recipient:${credentialId}`;

/** The key `data.sealed` holds sealed recipient details under. */
export const SEALED_FIELD = 'sealed';
/** Put in `data` when an event's recipient details were erased. */
export const ERASED_MARKER = { recipientDetails: 'erased' } as const;

interface SealedDetails {
  data?: Record<string, unknown>;
  actorLabel?: string;
  ip?: string;
  userAgent?: string;
}

/** AES-256-GCM with the credential's audit key: `{iv}.{ciphertext}.{tag}`, base64url. */
export function sealRecipientDetails(
  key: Buffer,
  credentialId: string,
  details: SealedDetails,
): string {
  return createKeyEncryption(key).encrypt(JSON.stringify(details), sealAad(credentialId));
}

/** The sealed details, or null when they can't be opened (wrong key or changed). */
export function openRecipientDetails(
  key: Buffer,
  credentialId: string,
  sealed: string,
): SealedDetails | null {
  try {
    const value = JSON.parse(createKeyEncryption(key).decrypt(sealed, sealAad(credentialId), 1));
    return value && typeof value === 'object' ? (value as SealedDetails) : null;
  } catch {
    return null;
  }
}

/** Drops empty values, so nothing is sealed when there is nothing to say. */
function sealedPart(recipient: RecipientDetails): SealedDetails | null {
  const data = Object.fromEntries(
    Object.entries(recipient.data ?? {}).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
  const details: SealedDetails = {
    ...(Object.keys(data).length > 0 && { data }),
    ...(recipient.actorLabel && { actorLabel: recipient.actorLabel }),
    ...(recipient.ip && { ip: recipient.ip }),
    ...(recipient.userAgent && { userAgent: recipient.userAgent.slice(0, 512) }),
  };
  return Object.keys(details).length > 0 ? details : null;
}

/**
 * Appends one event to the audit log. Pass the transaction that makes the change, so the event
 * is written if and only if the change is.
 */
export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  const data: Record<string, unknown> = { ...entry.data };
  if (entry.recipient) {
    if (entry.target?.type !== 'credential') {
      throw new Error('Recipient details are sealed with a credential’s key.');
    }
    const details = sealedPart(entry.recipient);
    if (details) {
      data[SEALED_FIELD] = sealRecipientDetails(entry.recipient.key, entry.target.id, details);
    }
  }
  await db.insert(auditEvent).values({
    orgId: entry.orgId ?? null,
    actorType: entry.actor.type,
    actorId: entry.actor.id ?? null,
    actorLabel: entry.actor.label ?? null,
    action: entry.action,
    targetType: entry.target?.type ?? null,
    targetId: entry.target?.id ?? null,
    ip: entry.request?.ip ?? null,
    userAgent: entry.request?.userAgent?.slice(0, 512) ?? null,
    data,
  });
}

export const SYSTEM_ACTOR: AuditActor = { type: 'system', label: 'credforge' };

// ---- reading ----

export type AuditRow = typeof auditEvent.$inferSelect;

/**
 * Audit events as they read: sealed recipient details are opened with their credentials' keys and
 * put back (into `data`, and the actor's label, IP address and browser). Where the recipient's
 * data was erased, `data` says `recipientDetails: "erased"` instead.
 */
export async function openAuditEvents(
  db: Queryable,
  orgId: string,
  rows: AuditRow[],
): Promise<AuditRow[]> {
  const ids = [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.targetType === 'credential' &&
            row.targetId &&
            isUuid(row.targetId) &&
            typeof row.data[SEALED_FIELD] === 'string',
        )
        .map((row) => (row.targetId as string).toLowerCase()),
    ),
  ];
  const keys = new Map<string, Buffer>();
  if (ids.length > 0) {
    for (const row of await db
      .select({ id: credential.id, key: credential.auditKey })
      .from(credential)
      .where(and(eq(credential.orgId, orgId), inArray(credential.id, ids)))) {
      if (row.key) keys.set(row.id, row.key);
    }
  }
  return rows.map((row) => {
    const sealed = row.data[SEALED_FIELD];
    if (typeof sealed !== 'string' || !row.targetId) return row;
    const { [SEALED_FIELD]: _sealed, ...plain } = row.data;
    const id = row.targetId.toLowerCase();
    const key = keys.get(id);
    const details = key ? openRecipientDetails(key, id, sealed) : null;
    if (!details) return { ...row, data: { ...plain, ...ERASED_MARKER } };
    return {
      ...row,
      data: { ...plain, ...details.data },
      actorLabel: details.actorLabel ?? row.actorLabel,
      ip: details.ip ?? row.ip,
      userAgent: details.userAgent ?? row.userAgent,
    };
  });
}
