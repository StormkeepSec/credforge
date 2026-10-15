import { auditEvent, type Queryable } from '@credforge/db';

export type AuditActor =
  | { type: 'user'; id: string; label: string | null }
  | { type: 'system'; id?: null; label?: string | null };

export interface AuditRequestInfo {
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
}

/**
 * Appends one event to the audit log. Pass the transaction that makes the change, so the event
 * is written if and only if the change is.
 */
export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<void> {
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
    data: entry.data ?? {},
  });
}

export const SYSTEM_ACTOR: AuditActor = { type: 'system', label: 'credforge' };
