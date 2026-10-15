import {
  and,
  credential,
  type Database,
  type EMAIL_STATUS_VALUES,
  type EmailEventData,
  emailMessage,
  eq,
  organization,
  sql,
} from '@credforge/db';
import { recordAudit, SYSTEM_ACTOR } from '../audit/audit';
import { type SendGridEvent, TRACKING_ARG } from './sendgrid';

type EmailStatus = (typeof EMAIL_STATUS_VALUES)[number];

/** What the email worker reports about tracked messages (`email_message` rows). */
export interface DeliveryTracker {
  /** Whether to send now: not if it already went out, or the org can no longer send. */
  beforeSend(id: string): Promise<{ send: boolean; reason?: string }>;
  sent(id: string, transport: string, providerMessageId: string | null): Promise<void>;
  failed(id: string, error: string, final: boolean): Promise<void>;
}

/**
 * Statuses only move forward: a late "processed" or "delivered" event never hides a bounce, and
 * a spam report outranks everything. Bounced, dropped and failed are final.
 */
const RANK: Record<EmailStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  bounced: 3,
  dropped: 3,
  failed: 3,
  spam_reported: 4,
};

const MAX_EVENTS = 50;

export function createDeliveryTracker(db: Database): DeliveryTracker {
  return {
    async beforeSend(id) {
      const [row] = await db
        .select({
          status: emailMessage.status,
          orgStatus: organization.status,
          credentialStatus: credential.status,
        })
        .from(emailMessage)
        .innerJoin(organization, eq(emailMessage.orgId, organization.id))
        .leftJoin(credential, eq(emailMessage.credentialId, credential.id))
        .where(eq(emailMessage.id, id));
      if (!row) return { send: false, reason: 'unknown message' };
      if (row.status !== 'queued') return { send: false, reason: `already ${row.status}` };
      const reason =
        row.orgStatus === 'suspended' || row.orgStatus === 'declined'
          ? `Not sent: the organization is ${row.orgStatus}.`
          : row.credentialStatus === 'revoked'
            ? 'Not sent: the badge was revoked before the email went out.'
            : null;
      if (reason) {
        await db
          .update(emailMessage)
          .set({ status: 'failed', lastError: reason, updatedAt: new Date() })
          .where(and(eq(emailMessage.id, id), eq(emailMessage.status, 'queued')));
        return { send: false, reason };
      }
      return { send: true };
    },

    async sent(id, transport, providerMessageId) {
      const now = new Date();
      await db
        .update(emailMessage)
        .set({
          transport,
          providerMessageId,
          attempts: sql`${emailMessage.attempts} + 1`,
          sentAt: now,
          lastError: null,
          updatedAt: now,
          // A webhook event may already have moved it past `sent`.
          status: sql`case when ${emailMessage.status} = 'queued' then 'sent' else ${emailMessage.status} end`,
        })
        .where(eq(emailMessage.id, id));
    },

    async failed(id, error, final) {
      await db
        .update(emailMessage)
        .set({
          attempts: sql`${emailMessage.attempts} + 1`,
          lastError: error.slice(0, 1000),
          updatedAt: new Date(),
          ...(final && {
            status: sql`case when ${emailMessage.status} = 'queued' then 'failed' else ${emailMessage.status} end`,
          }),
        })
        .where(eq(emailMessage.id, id));
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The status a SendGrid event leads to, or null for events that only go in the timeline. */
function statusFor(event: SendGridEvent): EmailStatus | null {
  switch (event.event) {
    case 'delivered':
      return 'delivered';
    case 'bounce':
      return 'bounced';
    case 'dropped':
      return 'dropped';
    case 'spamreport':
      return 'spam_reported';
    default:
      return null;
  }
}

/** Events kept in the delivery timeline. Opens and clicks never arrive (tracking is off). */
const RECORDED_EVENTS = new Set([
  'processed',
  'deferred',
  'delivered',
  'bounce',
  'dropped',
  'spamreport',
]);

/**
 * Applies a batch of verified SendGrid events to `email_message` rows. Events are matched by the
 * custom argument credforge sends with every tracked message, or else by SendGrid's message id.
 * Each event is applied once (by `sg_event_id`), so a redelivered batch changes nothing.
 * Returns the number of events applied.
 */
export async function applySendGridEvents(db: Database, events: SendGridEvent[]): Promise<number> {
  let applied = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object' || !RECORDED_EVENTS.has(event.event)) continue;
    const trackingId = event[TRACKING_ARG];
    const providerId = event.sg_message_id?.split('.')[0];
    const where =
      typeof trackingId === 'string' && UUID.test(trackingId)
        ? eq(emailMessage.id, trackingId.toLowerCase())
        : providerId
          ? eq(emailMessage.providerMessageId, providerId)
          : undefined;
    if (!where) continue;

    const at = new Date(
      typeof event.timestamp === 'number' ? event.timestamp * 1000 : Date.now(),
    ).toISOString();
    const reason =
      typeof event.reason === 'string'
        ? event.reason.slice(0, 300)
        : event.type
          ? String(event.type).slice(0, 50)
          : undefined;
    const record: EmailEventData & { id?: string } = {
      event: event.event === 'bounce' && event.type === 'blocked' ? 'blocked' : event.event,
      at,
      ...(reason && { reason }),
      ...(typeof event.sg_event_id === 'string' && { id: event.sg_event_id.slice(0, 100) }),
    };

    const changed = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(emailMessage).where(where).for('update');
      if (!row) return false;
      const seen = row.events as (EmailEventData & { id?: string })[];
      if (record.id && seen.some((entry) => entry.id === record.id)) return false;

      const next = statusFor(event);
      const advance = next !== null && RANK[next] > RANK[row.status];
      await tx
        .update(emailMessage)
        .set({
          events: [...seen, record].slice(-MAX_EVENTS),
          updatedAt: new Date(),
          ...(advance && { status: next }),
          ...(next === 'delivered' && !row.deliveredAt && { deliveredAt: new Date(at) }),
          ...(next === 'bounced' && { bouncedAt: new Date(at), lastError: reason ?? null }),
          ...(next === 'dropped' && { lastError: reason ?? null }),
        })
        .where(eq(emailMessage.id, row.id));
      if (advance && next !== 'delivered') {
        await recordAudit(tx, {
          orgId: row.orgId,
          actor: SYSTEM_ACTOR,
          action: `email.${next}`,
          target: row.credentialId
            ? { type: 'credential', id: row.credentialId }
            : { type: 'email_message', id: row.id },
          data: { emailId: row.id, kind: row.kind, ...(reason && { reason }) },
        });
      }
      return true;
    });
    if (changed) applied++;
  }
  return applied;
}
